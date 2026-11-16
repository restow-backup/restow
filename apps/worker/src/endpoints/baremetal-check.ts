/**
 * `endpoint-baremetal-check`: stage 1 of the bare metal restore check (docs/BAREMETAL.md 12.1)
 * for the newest whole machine snapshot of a Linux machine.
 *
 * Holding the repository lock shared (like the restore test), it reads the snapshot once: the
 * snapshot's paths, the agent's copy of the layout (L4), one walk over the tree for the restore
 * sizes, the sources and the boot chain, then the few files L6 reads. With the lock released it
 * builds the planner's facts and runs the agent's planner in its sandbox (./planner.ts) against
 * the same hardware, the smallest possible disks and another disk controller, rates everything
 * (@restow/core `judgeLayoutCheck`) and writes a `baremetal_check` report.
 *
 * A snapshot the repository no longer has gets a report without a rating (`readiness` null,
 * `summary.skipped` "snapshot_gone"), so it is not queued again.
 *
 * A read of the repository that fails for a reason that proves nothing about the backup (the
 * repository busy, restic stopped or unreachable) writes no report: the job fails with
 * {@link BaremetalCheckIncompleteError} and pg-boss retries it. A planner that cannot answer
 * (timeout, too much output, a crash, no binary) does prove nothing either, but it would fail the
 * same way again: that report is yellow and the next backup checks again.
 */

import { createHash } from "node:crypto";
import {
  bootChainFingerprint,
  bootChainInputOf,
  type CheckNode,
  canonicalLayoutJson,
  type DumpedFile,
  type EndpointJobPayload,
  isBackupFinding,
  judgeLayoutCheck,
  type LayoutCheckInput,
  LINUX_MANIFEST_PATH,
  type LinuxLayoutManifest,
  MAX_LAYOUT_BYTES,
  type PlannerOutcome,
  type PlannerRuns,
  type PlanTarget,
  ProbeFolderCounter,
  parseLayoutManifest,
  parseRunConsistency,
  planFactsOf,
  ResticError,
  type ResticSession,
  type RestoreSize,
  RestoreSizeCounter,
  reportValue,
  resticReadFile,
  resticSnapshot,
  resticWalk,
  restoreSizeTargets,
  StageOneCollector,
  stageOneDumps,
  stageOneWanted,
  withRepository,
} from "@restow/core";
import { endpointLayouts, endpointReports, endpointRuns } from "@restow/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { isUuid, withTenantTx } from "../handlers/framework.js";
import {
  type EndpointJobDeps,
  loadEndpoint,
  openEndpointRepository,
  reportableMessage,
  withMaintenanceLock,
  writeReport,
} from "./common.js";
import { plannerBinary, plannerVersion, runPlanner, type SandboxOptions } from "./planner.js";

/** Stage 1 could not read the snapshot; nothing was rated and the job is retried. */
export class BaremetalCheckIncompleteError extends Error {
  constructor(readonly reason: string) {
    super(`the bare metal check could not read the snapshot and will be retried: ${reason}`);
    this.name = "BaremetalCheckIncompleteError";
  }
}

export interface BaremetalCheckOptions {
  /** The planner binary (default `RESTOW_PLANNER_BIN`, else the image's copy). */
  plannerBin?: string;
  /** Tests run the planner without prlimit or with shorter limits. */
  sandbox?: Omit<SandboxOptions, "signal">;
}

/** What stage 1 read from the snapshot while it held the lock. */
interface SnapshotReading {
  snapshotPaths: string[];
  manifestInSnapshot: LayoutCheckInput["manifestInSnapshot"];
  nodes: Map<string, CheckNode>;
  childCounts: Map<string, number>;
  files: Map<string, DumpedFile>;
  restoreSizes: Record<string, RestoreSize>;
  /** Targets with more files than the counter remembers: their sizes are an upper bound. */
  restoreSizesUpperBound: string[];
  /** The sizes of the folders a boot probe may leave empty (12.3; at most the 200 largest). */
  folderSizes: Record<string, number>;
}

/** The snapshot is not in the repository (forgotten by retention since the job was queued). */
const SNAPSHOT_GONE =
  /no matching ID found|no snapshot matched|<snapshot\/[0-9a-f]+> does not exist/i;

function isSnapshotGone(error: unknown): boolean {
  return error instanceof ResticError && SNAPSHOT_GONE.test(error.stderr);
}

/** A read that failed for a reason that proves nothing about the backup. */
function incomplete(error: unknown): never {
  if (error instanceof BaremetalCheckIncompleteError) throw error;
  throw new BaremetalCheckIncompleteError(reportableMessage(error));
}

async function readSnapshot(
  session: ResticSession,
  snapshotId: string,
  manifest: LinuxLayoutManifest | null,
  signal: AbortSignal | undefined,
): Promise<SnapshotReading | null> {
  let snapshot: Awaited<ReturnType<typeof resticSnapshot>>;
  try {
    snapshot = await resticSnapshot(session, snapshotId, { signal });
  } catch (error) {
    if (isSnapshotGone(error)) return null;
    incomplete(error);
  }
  if (!snapshot) return null;

  // L4: the agent's copy of the manifest, byte for byte.
  let manifestInSnapshot: LayoutCheckInput["manifestInSnapshot"];
  try {
    const read = await resticReadFile(
      session,
      snapshotId,
      LINUX_MANIFEST_PATH,
      MAX_LAYOUT_BYTES + 1,
      {
        signal,
      },
    );
    manifestInSnapshot = {
      state: "found",
      sha256: createHash("sha256").update(read.bytes).digest("hex"),
      bytes: read.bytes.length,
    };
  } catch (error) {
    if (!isBackupFinding(error)) incomplete(error);
    manifestInSnapshot = { state: "missing" };
  }

  const nodes = new Map<string, CheckNode>();
  const childCounts = new Map<string, number>();
  const files = new Map<string, DumpedFile>();
  let restoreSizes: Record<string, RestoreSize> = {};
  let restoreSizesUpperBound: string[] = [];
  let folderSizes: Record<string, number> = {};
  if (manifest) {
    // One walk over the whole tree: restore sizes, the sources and the boot chain.
    const collector = new StageOneCollector(stageOneWanted(manifest));
    const counter = new RestoreSizeCounter(restoreSizeTargets(manifest));
    const folders = new ProbeFolderCounter();
    try {
      await resticWalk(
        session,
        snapshotId,
        (node) => {
          collector.add(node.path, { type: node.type, size: node.size, mtime: node.mtime });
          counter.add(node);
          folders.add(node);
        },
        { signal },
      );
    } catch (error) {
      incomplete(error);
    }
    for (const [path, node] of collector.nodes) nodes.set(path, node);
    for (const [path, count] of collector.childCounts) childCounts.set(path, count);
    restoreSizes = counter.result();
    restoreSizesUpperBound = counter.upperBounds();
    folderSizes = folders.result();
    for (const dump of stageOneDumps(manifest, nodes)) {
      try {
        files.set(
          dump.path,
          await resticReadFile(session, snapshotId, dump.path, dump.maxBytes, { signal }),
        );
      } catch (error) {
        // A file restic reports damaged counts as unreadable: the checks then miss it.
        if (!isBackupFinding(error)) incomplete(error);
      }
    }
  }
  return {
    snapshotPaths: snapshot.paths,
    manifestInSnapshot,
    nodes,
    childCounts,
    files,
    restoreSizes,
    restoreSizesUpperBound,
    folderSizes,
  };
}

const PLAN_RUNS: [keyof PlannerRuns, PlanTarget][] = [
  ["same", "same"],
  ["minimal", "minimal"],
  ["otherController", "other-controller"],
];

/** What the report keeps of a planner run. */
function plannerSummary(outcome: PlannerOutcome): Record<string, unknown> {
  if (outcome.kind === "incomplete") return { ok: null, incomplete: outcome.reason };
  if (outcome.kind === "refused") return { ok: false, refused: outcome.error.code };
  const keep = (findings: typeof outcome.plan.problems) =>
    findings.slice(0, 50).map((finding) => ({
      code: finding.code,
      ref: finding.ref,
      params: reportValue(finding.params),
    }));
  return {
    ok: outcome.plan.ok,
    problems: keep(outcome.plan.problems),
    warnings: keep(outcome.plan.warnings),
    // Which storage drivers the backed-up kernel has for that target's controllers: the wizard's
    // hardware guide names them (docs/BAREMETAL.md 14.6 step 2).
    storage: outcome.plan.drivers.storage.slice(0, 64).map((driver) =>
      reportValue({
        module: typeof driver.module === "string" ? driver.module : "",
        found: driver.found === true,
        builtin: driver.builtin === true,
      }),
    ),
  };
}

function minimumSizesOf(runs: PlannerRuns | null): Record<string, unknown> | null {
  const outcome = runs ? [runs.same, runs.minimal].find((run) => run.kind === "plan") : undefined;
  if (outcome?.kind !== "plan") return null;
  return reportValue({
    disks: outcome.plan.minimumSizes.disks.map((disk) => ({
      disk: disk.disk,
      kname: disk.kname,
      sizeBytes: disk.sizeBytes,
      minBytes: disk.minBytes,
    })),
    filesystems: outcome.plan.minimumSizes.filesystems.map((fs) => ({
      fs: fs.fs,
      mount: fs.mount,
      type: fs.type,
      restoreBytes: fs.restoreBytes,
      minBytes: fs.minBytes,
    })),
  }) as Record<string, unknown>;
}

export async function endpointBaremetalCheck(
  deps: EndpointJobDeps,
  payload: EndpointJobPayload,
  options: BaremetalCheckOptions = {},
): Promise<void> {
  const { tenantId, endpointId } = payload;
  const { logger } = deps.runtime;
  const signal = deps.runtime.shutdownSignal;
  const endpoint = await loadEndpoint(deps, tenantId, endpointId);
  if (endpoint?.status !== "active" || endpoint.os !== "linux" || !endpoint.repositorySecretId) {
    return;
  }
  const runId = isUuid(payload.runId) ? payload.runId : undefined;
  // The newest run that recorded a layout (or the one the finish asked for), with its layout.
  const latest = await withTenantTx(deps.db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        runId: endpointRuns.id,
        snapshotId: endpointRuns.snapshotId,
        stats: endpointRuns.stats,
        layout: endpointLayouts,
      })
      .from(endpointRuns)
      .innerJoin(endpointLayouts, eq(endpointLayouts.id, endpointRuns.layoutId))
      .where(
        and(
          eq(endpointRuns.endpointId, endpointId),
          isNotNull(endpointRuns.layoutId),
          ...(runId ? [eq(endpointRuns.id, runId)] : []),
        ),
      )
      .orderBy(desc(endpointRuns.startedAt))
      .limit(1);
    if (!row?.snapshotId) return null;
    const [checked] = payload.force
      ? []
      : await tx
          .select({ id: endpointReports.id })
          .from(endpointReports)
          .where(
            and(
              eq(endpointReports.endpointId, endpointId),
              eq(endpointReports.kind, "baremetal_check"),
              eq(endpointReports.snapshotId, row.snapshotId),
            ),
          )
          .limit(1);
    return checked ? null : row;
  });
  if (latest?.layout.platform !== "linux") {
    return;
  }
  const snapshotId = latest.snapshotId as string;
  const parsed = parseLayoutManifest(latest.layout.manifest);
  const manifest = parsed.ok && parsed.manifest.platform === "linux" ? parsed.manifest : null;

  const { access } = await openEndpointRepository(deps, tenantId, endpointId);
  // Shared with the API's reads and the restore test, never beside retention or the check.
  const reading = await withMaintenanceLock(deps, endpointId, "shared", () =>
    withRepository(access, (session) => readSnapshot(session, snapshotId, manifest, signal)),
  );
  if (!reading) {
    // Terminal: a report without a rating, so the scheduler stops queueing this snapshot (it
    // asks only whether a report exists) and the API ignores it (readiness null). This happens
    // when later backups record no layout and retention forgets the last one that did.
    await writeReport(
      deps,
      tenantId,
      {
        endpointId,
        kind: "baremetal_check",
        origin: "server",
        snapshotId,
        runId: latest.runId,
        readiness: null,
        summary: { skipped: "snapshot_gone", layoutId: latest.layout.id },
      },
      deps.runtime.now(),
    );
    logger.info("bare metal check skipped, the snapshot is gone", {
      tenantId,
      endpointId,
      snapshotId,
    });
    return;
  }

  // The planner, with the lock released: three runs in the sandbox.
  const bin = options.plannerBin ?? plannerBinary();
  let planner: PlannerRuns | null = null;
  let version: string | null = null;
  if (manifest) {
    const bytes = Buffer.from(canonicalLayoutJson(latest.layout.manifest), "utf8");
    const facts = planFactsOf(manifest, reading.nodes, reading.files, reading.restoreSizes);
    const runs: Partial<PlannerRuns> = {};
    for (const [key, target] of PLAN_RUNS) {
      const run = await runPlanner({
        bin,
        manifest: bytes,
        facts,
        target,
        signal,
        sandbox: options.sandbox,
      });
      runs[key] = run.outcome;
      if (run.outcome.kind === "incomplete") {
        logger.warn("bare metal planner could not answer", {
          tenantId,
          endpointId,
          target,
          reason: run.outcome.reason,
          stderr: run.stderr.slice(-500),
        });
      }
    }
    planner = runs as PlannerRuns;
    version = await plannerVersion(bin, options.sandbox).catch(() => null);
  }

  const result = judgeLayoutCheck({
    manifest: latest.layout.manifest,
    layoutSha256: latest.layout.sha256,
    manifestInSnapshot: reading.manifestInSnapshot,
    snapshotPaths: reading.snapshotPaths,
    nodes: reading.nodes,
    childCounts: reading.childCounts,
    files: reading.files,
    consistency: parseRunConsistency(latest.stats?.consistency),
    restoreSizes: reading.restoreSizes,
    planner,
  });
  const bootChain = manifest
    ? bootChainFingerprint(bootChainInputOf(manifest, reading.nodes, reading.files))
    : null;
  const summary = {
    layoutId: latest.layout.id,
    layoutSha256: latest.layout.sha256,
    layoutFingerprint: latest.layout.layoutFingerprint,
    bootChainFingerprint: bootChain,
    checks: result.checks,
    restoreSizes: reading.restoreSizes,
    restoreSizesUpperBound: reading.restoreSizesUpperBound,
    folderSizes: reading.folderSizes,
    minimumSizes: minimumSizesOf(planner),
    planner: planner
      ? {
          same: plannerSummary(planner.same),
          minimal: plannerSummary(planner.minimal),
          otherController: plannerSummary(planner.otherController),
        }
      : null,
    plannerVersion: version,
    incomplete: result.incomplete,
  };
  await writeReport(
    deps,
    tenantId,
    {
      endpointId,
      kind: "baremetal_check",
      origin: "server",
      snapshotId,
      runId: latest.runId,
      readiness: result.readiness,
      summary,
    },
    deps.runtime.now(),
  );
  logger.info("endpoint bare metal check finished", {
    tenantId,
    endpointId,
    snapshotId,
    readiness: result.readiness,
    incomplete: result.incomplete,
    failed: result.checks.filter((check) => check.status === "failed").map((check) => check.id),
  });
}
