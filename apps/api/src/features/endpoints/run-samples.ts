import { endpoints, recordRunSample, runSamples, samplePoint } from "@restow/db";
import { and, eq } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";

/**
 * The throughput history of an agent run (`run_samples`, @restow/db run-samples.ts).
 *
 * What the agent reports is how much it has read (`bytesDone`). What it has uploaded it does not
 * know, but the server does: every object the agent writes passes through the restic REST route
 * (restic-route.ts), which keeps `endpoints.repository_bytes` current with every upload. The
 * repository's growth since the run started is therefore what the machine transferred, after
 * deduplication and compression, as a counter the server measured itself. The size at the start
 * is the baseline kept with the samples.
 *
 * A repository that was never measured has no size to start from. A machine that never backed
 * up has a new, empty repository, so it starts from zero; any other machine takes the first
 * measurement it gets as its baseline (the few seconds uploaded before it are not counted).
 */

/** The baseline a run starts with: the repository's size, zero for a machine's first backup, else unknown. */
export function baselineAtStart(endpoint: {
  repositoryBytes: number | null;
  lastBackupAt: Date | null;
}): number | null {
  if (endpoint.repositoryBytes !== null) {
    return endpoint.repositoryBytes;
  }
  return endpoint.lastBackupAt === null ? 0 : null;
}

/** What the repository grew since the baseline; zero while either is unknown, never negative. */
export function transferredSince(baseline: number | null, repositoryBytes: number | null): number {
  if (baseline === null || repositoryBytes === null) {
    return 0;
  }
  return Math.max(0, repositoryBytes - baseline);
}

async function loadEndpointSize(tx: Transaction, endpointId: string) {
  const [row] = await tx
    .select({ repositoryBytes: endpoints.repositoryBytes, lastBackupAt: endpoints.lastBackupAt })
    .from(endpoints)
    .where(eq(endpoints.id, endpointId))
    .limit(1);
  return row ?? { repositoryBytes: null, lastBackupAt: null };
}

interface RunScope {
  tenantId: string;
  endpointId: string;
}

/** The first point of a run: nothing processed or transferred yet, and the repository's size. */
export async function startRunSamples(
  tx: Transaction,
  scope: RunScope,
  runId: string,
  now: Date,
): Promise<void> {
  const size = await loadEndpointSize(tx, scope.endpointId);
  await recordRunSample(
    tx,
    { tenantId: scope.tenantId, endpointRunId: runId },
    samplePoint(now.getTime(), 0, 0),
    { baselineBytes: baselineAtStart(size), now },
  );
}

/**
 * One measurement from a progress report (`processed` is what the agent has read). Takes the
 * repository's size as the baseline when the run started without one.
 */
export async function recordProgressSample(
  tx: Transaction,
  scope: RunScope,
  runId: string,
  processed: number,
  now: Date,
): Promise<void> {
  const size = await loadEndpointSize(tx, scope.endpointId);
  const [row] = await tx
    .select({ baseline: runSamples.baselineBytes })
    .from(runSamples)
    .where(and(eq(runSamples.tenantId, scope.tenantId), eq(runSamples.endpointRunId, runId)))
    .limit(1);
  let baseline = row?.baseline ?? null;
  if (row && baseline === null && size.repositoryBytes !== null) {
    baseline = size.repositoryBytes;
    await tx
      .update(runSamples)
      .set({ baselineBytes: baseline })
      .where(and(eq(runSamples.tenantId, scope.tenantId), eq(runSamples.endpointRunId, runId)));
  }
  await recordRunSample(
    tx,
    { tenantId: scope.tenantId, endpointRunId: runId },
    samplePoint(now.getTime(), processed, transferredSince(baseline, size.repositoryBytes)),
    { baselineBytes: baseline, now },
  );
}
