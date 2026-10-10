import { and, eq } from "drizzle-orm";
import type { Database } from "./index.js";
import { type RunSamplePoint, runSamples } from "./schema/run-samples.js";

/**
 * The throughput history of a run (`run_samples`): which points are kept, how old ones are
 * thinned, how a rate follows from two neighbours, and the one write that appends a point.
 * The pure parts come first so the compaction is tested without a database; `recordRunSample`
 * is the shared write of the worker (mail runs) and the API (runs an agent or a file share
 * runner reports).
 *
 * A point holds cumulative counters, never rates. Dropping the point between two others
 * therefore changes how finely time is resolved, not how many bytes were counted, and the
 * rate over a longer stretch is still exact.
 */

export type { RunSamplePoint } from "./schema/run-samples.js";

/** The most points kept for one run. */
export const MAX_RUN_SAMPLES = 300;
/** Closer together than this, a new measurement replaces the last point instead of adding one. */
export const MIN_SAMPLE_GAP_MS = 1500;
/** The newest points are never thinned: about five minutes at one point every two seconds. */
const KEEP_RECENT = MAX_RUN_SAMPLES / 2;

function finite(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** A point from raw numbers: whole bytes, never negative or not-a-number. */
export function samplePoint(at: number, processed: number, transferred: number): RunSamplePoint {
  return [Math.round(at), finite(processed), finite(transferred)];
}

/**
 * Thin the older half: from the points older than the newest {@link KEEP_RECENT}, every second one
 * goes, but the first (the start of the run) stays. Applied when the history outgrows its bound,
 * so resolution fades with age and the newest stretch keeps its full resolution.
 */
export function compactSamples(
  points: readonly RunSamplePoint[],
  max: number = MAX_RUN_SAMPLES,
): RunSamplePoint[] {
  if (points.length <= max) {
    return [...points];
  }
  const keepRecent = Math.min(KEEP_RECENT, Math.floor(max / 2));
  const split = points.length - keepRecent;
  const older = points.slice(0, split).filter((_, index) => index % 2 === 0);
  const recent = points.slice(split);
  const merged = [...older, ...recent];
  // Still over (a tiny `max`): thin again until it fits.
  return merged.length > max ? compactSamples(merged, max) : merged;
}

/**
 * The points after a new measurement. A measurement at or before the last point's time is
 * dropped (out of order), one within {@link MIN_SAMPLE_GAP_MS} of the last point replaces it
 * (so a burst of progress reports cannot fill the history, and the last point is always the
 * newest state), anything else is appended. The history is compacted when it outgrows its bound.
 */
export function appendSample(
  points: readonly RunSamplePoint[],
  next: RunSamplePoint,
  max: number = MAX_RUN_SAMPLES,
): RunSamplePoint[] {
  const last = points[points.length - 1];
  if (last && next[0] <= last[0]) {
    return [...points];
  }
  if (last && points.length > 1 && next[0] - last[0] < MIN_SAMPLE_GAP_MS) {
    return [...points.slice(0, -1), next];
  }
  return compactSamples([...points, next], max);
}

/** The newest `count` points. */
export function latestSamples(points: readonly RunSamplePoint[], count: number): RunSamplePoint[] {
  return count >= points.length ? [...points] : points.slice(points.length - count);
}

/** Bytes per second between two points; a counter that went back (a restarted run) counts as 0. */
function perSecond(from: number, to: number, seconds: number): number {
  return seconds > 0 ? Math.max(0, to - from) / seconds : 0;
}

export interface Throughput {
  /** Bytes read and handled per second. */
  processedBps: number;
  /** Bytes written to the repository per second. */
  transferredBps: number;
}

/**
 * The speed over the newest stretch: the counters' growth from the oldest point that is no more
 * than `windowMs` before the newest one, to the newest. Null while there is not a second point.
 */
export function currentThroughput(
  points: readonly RunSamplePoint[],
  windowMs = 20_000,
): Throughput | null {
  const last = points[points.length - 1];
  if (!last || points.length < 2) {
    return null;
  }
  let from = points[points.length - 2] as RunSamplePoint;
  for (let index = points.length - 2; index >= 0; index--) {
    const candidate = points[index] as RunSamplePoint;
    if (last[0] - candidate[0] > windowMs) {
      break;
    }
    from = candidate;
  }
  const seconds = (last[0] - from[0]) / 1000;
  return {
    processedBps: perSecond(from[1], last[1], seconds),
    transferredBps: perSecond(from[2], last[2], seconds),
  };
}

/** The rate of every step between neighbouring points, at the later point's time. */
export function sampleRates(
  points: readonly RunSamplePoint[],
): { at: number; processedBps: number; transferredBps: number }[] {
  const rates: { at: number; processedBps: number; transferredBps: number }[] = [];
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1] as RunSamplePoint;
    const to = points[index] as RunSamplePoint;
    const seconds = (to[0] - from[0]) / 1000;
    rates.push({
      at: to[0],
      processedBps: perSecond(from[1], to[1], seconds),
      transferredBps: perSecond(from[2], to[2], seconds),
    });
  }
  return rates;
}

/** A transaction of the application's database handle (the tenant-pinned one the callers hold). */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface RunSampleTarget {
  tenantId: string;
  /** A mail run: the `jobs` row. */
  jobId?: string;
  /** A run an agent reported: the `endpoint_runs` row. */
  endpointRunId?: string;
  /** A file share run its runner reports: the `file_share_runs` row. */
  fileShareRunId?: string;
}

function ofRun(target: RunSampleTarget) {
  if (target.jobId !== undefined) {
    return and(eq(runSamples.tenantId, target.tenantId), eq(runSamples.jobId, target.jobId));
  }
  if (target.fileShareRunId !== undefined) {
    return and(
      eq(runSamples.tenantId, target.tenantId),
      eq(runSamples.fileShareRunId, target.fileShareRunId),
    );
  }
  return and(
    eq(runSamples.tenantId, target.tenantId),
    eq(runSamples.endpointRunId, target.endpointRunId as string),
  );
}

/**
 * Add one measurement to a run's history inside the transaction `tx` (pinned to the tenant, so
 * Row Level Security applies). Creates the row on the first measurement. `baselineBytes` is kept
 * from the call that created the row (an agent run's repository size at its start).
 */
export async function recordRunSample(
  tx: Transaction,
  target: RunSampleTarget,
  point: RunSamplePoint,
  options: { baselineBytes?: number | null; now?: Date } = {},
): Promise<RunSamplePoint[]> {
  const [row] = await tx
    .select({ id: runSamples.id, points: runSamples.points })
    .from(runSamples)
    .where(ofRun(target))
    .for("update")
    .limit(1);
  if (!row) {
    const points = appendSample([], point);
    await tx
      .insert(runSamples)
      .values({
        tenantId: target.tenantId,
        jobId: target.jobId ?? null,
        endpointRunId: target.endpointRunId ?? null,
        fileShareRunId: target.fileShareRunId ?? null,
        points,
        baselineBytes: options.baselineBytes ?? null,
      })
      .onConflictDoNothing();
    return points;
  }
  const points = appendSample(row.points, point);
  await tx
    .update(runSamples)
    .set({ points, updatedAt: options.now ?? new Date() })
    .where(eq(runSamples.id, row.id));
  return points;
}
