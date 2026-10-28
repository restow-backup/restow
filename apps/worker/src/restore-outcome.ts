/**
 * What a completed restore actually did, for the alerts it raises (reporting.ts, the
 * job.completed / job.failed webhooks). Engines record item errors per item, so a restore that
 * could write nothing still ends "completed": with failed items and nothing restored it is
 * reported as a failure (restore.failed, job.failed), and one that skipped everything (nothing
 * restored, nothing failed) as completed but never as a success. The same rule as the web UI
 * (apps/web features/restore/lib/jobs.ts, completedOutcome); keep both in step.
 */
import { jobs } from "@restow/db";
import { eq, sql } from "drizzle-orm";
import type { TenantTx } from "./progress.js";

/** The counters of `jobs.payload.result` a restore stores (handlers/restore.ts). */
export interface RestoreCounts {
  readonly restored: number;
  readonly skipped: number;
  readonly failures: number;
  readonly unverified: number;
}

export type RestoreOutcome = "clean" | "issues" | "nothingRestored" | "allSkipped";

/** The outcome of a completed restore by its counters; "clean" when none are known. */
export function restoreOutcome(counts: RestoreCounts | null | undefined): RestoreOutcome {
  if (!counts) {
    return "clean";
  }
  if (counts.restored === 0 && counts.failures > 0) {
    return "nothingRestored";
  }
  if (counts.failures > 0 || counts.unverified > 0) {
    return "issues";
  }
  if (counts.restored === 0 && counts.skipped > 0) {
    return "allSkipped";
  }
  return "clean";
}

/** The error of a restore that completed without restoring a single item. */
export function nothingRestoredMessage(failures: number): string {
  return `Nothing was restored: ${failures} ${failures === 1 ? "item" : "items"} failed.`;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The counters of a stored restore result; null when there is none (or not an object). */
export function restoreCountsOf(result: unknown): RestoreCounts | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const value = result as Record<string, unknown>;
  // An older result stored the failures as a list.
  const failures = Array.isArray(value.failures) ? value.failures.length : count(value.failures);
  return {
    restored: count(value.restored),
    skipped: count(value.skipped),
    failures,
    unverified: count(value.unverified),
  };
}

/** The stored counters (`jobs.payload.result`) of a completed restore job; null for every other job. */
export async function loadRestoreCounts(
  tx: TenantTx,
  job: { readonly id: string; readonly queue: string; readonly status: string },
): Promise<RestoreCounts | null> {
  if (job.queue !== "restore" || job.status !== "completed") {
    return null;
  }
  const [row] = await tx
    .select({ result: sql<unknown>`${jobs.payload} -> 'result'` })
    .from(jobs)
    .where(eq(jobs.id, job.id))
    .limit(1);
  return restoreCountsOf(row?.result);
}
