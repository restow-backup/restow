// The tick loop. Only the elected leader enqueues, and only one tick runs at a
// time. The wall clock is read inside each tick (never at module load) so a
// long-lived process always plans against the current time.
//
// Per tick: first give tenants that just got their first active source the
// recommended schedules (once per tenant, see ScheduleStore), then load the
// due schedules (cross-tenant, bounded by batchSize), and for each one compute
// its next run, expand it into jobs against the tenant's current protected
// objects and sources, and enqueue those jobs together with the schedule
// update in one transaction. A schedule that cannot be planned (bad cron,
// unknown zone) is deferred instead of retried every tick.

import { randomUUID } from "node:crypto";
import type PgBoss from "pg-boss";
import type { EndpointJobPlanner } from "./endpoints.js";
import { errorMessage, logger } from "./logger.js";
import { type ScheduleRow, computeNextRunAt, expandSchedule } from "./planning.js";
import { type ReportRuleStore, runDueReports } from "./reports.js";
import type { ScheduleStore } from "./store.js";

export interface SchedulerLoopDeps {
  readonly store: ScheduleStore;
  readonly boss: PgBoss;
  readonly tickIntervalMs: number;
  /** Maximum schedules handled per tick. */
  readonly batchSize: number;
  /** How far to push a schedule that failed to plan before trying it again. */
  readonly deferMs: number;
  /** Reports current leadership; the loop enqueues nothing while false. */
  readonly isLeader: () => boolean;
  /**
   * Apply the recommended schedules to tenants that have an active source and
   * none applied yet, in this zone. Omitted, the loop only runs existing
   * schedules (tests that exercise the planner alone).
   */
  readonly recommendedDefaults?: { readonly timezone: string };
  /** Time-triggered report rules (./reports.ts); omitted, the loop runs schedules only. */
  readonly reports?: ReportRuleStore;
  /** Server-side jobs of endpoint backup (./endpoints.ts); omitted, the loop plans none. */
  readonly endpoints?: EndpointJobPlanner;
  /** Injectable clock and job id source (tests pin them). */
  readonly now?: () => Date;
  readonly newJobId?: () => string;
}

export interface TickSummary {
  /** Tenants that received the recommended schedules this tick. */
  readonly tenantsInitialised: number;
  readonly schedules: number;
  readonly enqueued: number;
  readonly skipped: number;
  readonly deferred: number;
  /** Report rules that fired and the deliveries they queued. */
  readonly reportsFired: number;
  readonly reportDeliveries: number;
}

export class SchedulerLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = false;
  private readonly now: () => Date;
  private readonly newJobId: () => string;

  constructor(private readonly deps: SchedulerLoopDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newJobId = deps.newJobId ?? randomUUID;
  }

  /** Start the interval. Safe to call once leadership is acquired. */
  start(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.tickIntervalMs);
    // The interval alone must not keep the process alive during shutdown.
    this.timer.unref();
    // Do not wait a full interval for the first pass after winning leadership.
    void this.tick();
  }

  /** One pass over the due schedules. Public so tests and the CLI can drive it. */
  async tick(): Promise<TickSummary | null> {
    // Skip while stopped, already ticking, or not the leader — no overlap.
    if (this.stopped || this.ticking || !this.deps.isLeader()) return null;
    this.ticking = true;
    const now = this.now();
    const summary = {
      tenantsInitialised: 0,
      schedules: 0,
      enqueued: 0,
      skipped: 0,
      deferred: 0,
      reportsFired: 0,
      reportDeliveries: 0,
    };
    try {
      summary.tenantsInitialised = await this.applyRecommendedDefaults(now);
      const due = await this.deps.store.loadDue(now, this.deps.batchSize);
      summary.schedules = due.length;
      for (const schedule of due) {
        if (this.stopped || !this.deps.isLeader()) break;
        const outcome = await this.runSchedule(schedule, now);
        summary.enqueued += outcome.enqueued;
        summary.skipped += outcome.skipped;
        summary.deferred += outcome.deferred;
      }
      if (this.deps.reports && !this.stopped && this.deps.isLeader()) {
        const reports = await runDueReports(
          this.deps.reports,
          now,
          this.deps.batchSize,
          (rule, err) =>
            logger.error("report rule could not be run", {
              ruleId: rule.id,
              err: errorMessage(err),
            }),
        );
        summary.reportsFired = reports.fired;
        summary.reportDeliveries = reports.deliveries;
      }
      if (this.deps.endpoints && !this.stopped && this.deps.isLeader()) {
        const planned = await this.deps.endpoints.plan(now);
        if (planned && (planned.retention || planned.check || planned.verify)) {
          logger.info("endpoint jobs queued", { ...planned, at: now.toISOString() });
        }
      }
      if (due.length > 0 || summary.tenantsInitialised > 0 || summary.reportsFired > 0) {
        logger.info("tick finished", { ...summary, at: now.toISOString() });
      } else {
        logger.debug("no due schedules this tick", { at: now.toISOString() });
      }
      return summary;
    } catch (err) {
      logger.error("scheduler tick failed", { err: errorMessage(err) });
      return summary;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Give waiting tenants the recommended schedules. Failures are logged per
   * tenant and retried next tick; they never hold up the due schedules.
   */
  private async applyRecommendedDefaults(now: Date): Promise<number> {
    const defaults = this.deps.recommendedDefaults;
    if (!defaults) return 0;
    let tenantIds: string[];
    try {
      tenantIds = await this.deps.store.loadTenantsAwaitingDefaults(this.deps.batchSize);
    } catch (err) {
      logger.error("looking up tenants without recommended schedules failed", {
        err: errorMessage(err),
      });
      return 0;
    }
    let initialised = 0;
    for (const tenantId of tenantIds) {
      if (this.stopped || !this.deps.isLeader()) break;
      try {
        const result = await this.deps.store.applyRecommendedDefaults(
          tenantId,
          defaults.timezone,
          now,
        );
        if (result.applied) {
          initialised++;
          logger.info("recommended schedules applied", {
            tenantId,
            created: [...result.created],
            timezone: defaults.timezone,
          });
        }
      } catch (err) {
        logger.error("applying recommended schedules failed", { tenantId, err: errorMessage(err) });
      }
    }
    return initialised;
  }

  private async runSchedule(
    schedule: ScheduleRow,
    now: Date,
  ): Promise<{ enqueued: number; skipped: number; deferred: number }> {
    const fields = { scheduleId: schedule.id, tenantId: schedule.tenantId, kind: schedule.kind };
    let nextRunAt: Date;
    try {
      nextRunAt = computeNextRunAt(schedule, now);
    } catch (err) {
      const deferredUntil = new Date(now.getTime() + this.deps.deferMs);
      logger.error("schedule cannot be planned, deferring", {
        ...fields,
        err: errorMessage(err),
        until: deferredUntil.toISOString(),
      });
      await this.deps.store.defer(schedule, deferredUntil);
      return { enqueued: 0, skipped: 0, deferred: 1 };
    }

    try {
      const targets = await this.deps.store.loadTargets(schedule.tenantId);
      const jobs = expandSchedule(schedule, targets, this.newJobId);
      const result = await this.deps.store.enqueue(this.deps.boss, schedule, jobs, nextRunAt, now);
      logger.info("schedule ran", {
        ...fields,
        planned: jobs.length,
        ...result,
        nextRunAt: nextRunAt.toISOString(),
      });
      return { ...result, deferred: 0 };
    } catch (err) {
      // Nothing was committed; the schedule stays due and is retried next tick.
      logger.error("schedule enqueue failed", { ...fields, err: errorMessage(err) });
      return { enqueued: 0, skipped: 0, deferred: 0 };
    }
  }

  /** Stop the interval and wait for any in-flight tick to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.ticking) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
