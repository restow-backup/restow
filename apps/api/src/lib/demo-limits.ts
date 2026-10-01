import { jobs } from "@restow/db";
import { and, eq, inArray } from "drizzle-orm";
import { ProblemError } from "../problem.js";
import type { DbExecutor } from "./tenant-context.js";

/**
 * Resource-use limits that apply only in demo mode (security review finding
 * 3): a public visitor triggering "Back up now" / "Verify now" / a restore
 * repeatedly, or downloading a large restore repeatedly, must not be able to
 * grow disk use or worker load without bound on a server that may be
 * co-hosted with production. Every limit here is a no-op unless the caller
 * itself is already inside a demo-mode code path — these functions do not
 * read `config.demo.enabled` themselves, so the same checks are exercised in
 * tests without needing to flip the environment (callers gate the call:
 * features/jobs/service.ts for "Back up now" and the automatic first backup,
 * features/verify/service.ts and features/restore/service.ts).
 */

const IN_FLIGHT_STATUSES = ["queued", "active"] as const;

export const DEMO_CONCURRENCY_PROBLEM = "urn:restow:problem:demo-job-in-progress";

export type DemoLimitedQueue = "backup" | "restore" | "verify";

/**
 * Whether the tenant already has a queued or active job of `queue`. The
 * non-throwing form of {@link assertDemoJobNotInFlight}, for a caller that
 * must not fail its own request over the limit: the first-backup enqueue
 * that runs after an object became protected (features/jobs/service.ts
 * `enqueueFirstBackups`) skips instead, because the change that triggered it
 * has already committed.
 */
export async function isDemoJobInFlight(
  tx: DbExecutor,
  tenantId: string,
  queue: DemoLimitedQueue,
): Promise<boolean> {
  const [existing] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.queue, queue),
        inArray(jobs.status, IN_FLIGHT_STATUSES),
      ),
    )
    .limit(1);
  return existing !== undefined;
}

/** One `backup`/`verify`/`restore` job at a time per tenant, in demo mode. */
export async function assertDemoJobNotInFlight(
  tx: DbExecutor,
  tenantId: string,
  queue: DemoLimitedQueue,
): Promise<void> {
  if (await isDemoJobInFlight(tx, tenantId, queue)) {
    throw new ProblemError(409, "Demo: one job of this kind at a time", {
      type: DEMO_CONCURRENCY_PROBLEM,
      detail:
        "This demo allows one backup, verification or restore per tenant at a time. Wait for the current one to finish and try again.",
      extensions: { queue },
    });
  }
}

// ---------------------------------------------------------------------------
// Restore size and daily budget
// ---------------------------------------------------------------------------

export const DEMO_RESTORE_SIZE_PROBLEM = "urn:restow:problem:demo-restore-too-large";
export const DEMO_RESTORE_BUDGET_PROBLEM = "urn:restow:problem:demo-restore-budget-exhausted";

/** Per-request cap: a single restore may not exceed this many bytes. */
export const DEMO_MAX_RESTORE_BYTES = 500 * 1024 * 1024;

/** Cumulative daily cap across the whole installation. */
export const DEMO_DAILY_RESTORE_BYTES = 2 * 1024 * 1024 * 1024;
export const DEMO_DAILY_RESTORE_ITEMS = 20_000;

export function assertDemoRestoreSizeOk(estimatedBytes: number): void {
  if (estimatedBytes <= DEMO_MAX_RESTORE_BYTES) {
    return;
  }
  throw new ProblemError(413, "Demo: restore too large", {
    type: DEMO_RESTORE_SIZE_PROBLEM,
    detail: `This demo limits a single restore to ${Math.floor(DEMO_MAX_RESTORE_BYTES / (1024 * 1024))} MB.`,
  });
}

interface DailyBudget {
  bytes: number;
  items: number;
  /** Epoch ms of the next UTC-day rollover. */
  resetAt: number;
}

/** Start of the next UTC day after `nowMs`, in epoch ms. */
function nextUtcDayBoundary(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

let budget: DailyBudget = { bytes: 0, items: 0, resetAt: nextUtcDayBoundary(Date.now()) };

function currentBudget(nowMs: number): DailyBudget {
  if (nowMs >= budget.resetAt) {
    budget = { bytes: 0, items: 0, resetAt: nextUtcDayBoundary(nowMs) };
  }
  return budget;
}

/** Reset the in-memory daily counters; tests only. */
export function resetDemoRestoreBudgetForTests(): void {
  budget = { bytes: 0, items: 0, resetAt: nextUtcDayBoundary(Date.now()) };
}

/**
 * Refuse a restore that would push the installation's rolling daily total
 * (an in-memory, process-local counter — it resets with the nightly restart
 * anyway, and never needs to survive one) past the cap. Call before
 * enqueueing; call {@link recordDemoRestoreUsage} only after the restore is
 * actually created.
 */
export function assertDemoRestoreBudgetOk(
  estimatedBytes: number,
  itemCount: number,
  now: number = Date.now(),
): void {
  const current = currentBudget(now);
  if (
    current.bytes + estimatedBytes > DEMO_DAILY_RESTORE_BYTES ||
    current.items + itemCount > DEMO_DAILY_RESTORE_ITEMS
  ) {
    throw new ProblemError(429, "Demo: daily restore budget used up", {
      type: DEMO_RESTORE_BUDGET_PROBLEM,
      detail: "This demo's daily restore budget is used up for today. It resets at midnight UTC.",
    });
  }
}

export function recordDemoRestoreUsage(
  bytes: number,
  itemCount: number,
  now: number = Date.now(),
): void {
  const current = currentBudget(now);
  current.bytes += bytes;
  current.items += itemCount;
}
