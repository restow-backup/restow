/**
 * The dispatcher of file share runs (docs/FILESHARES.md 8.2): a loop every 15 seconds, in one
 * worker at a time (a session advisory lock), that starts queued runs in runner containers
 * through the mounter. Restores first, then the oldest; never more than the installation's
 * `maxConcurrentRunners` at once and never two runs on the same share mount (the run's
 * `lock_share_id`; the database's partial unique index decides a race). For each run, in order:
 *
 *   1. move it to `starting`;
 *   2. check the shares: not retired, the tenant active, a restore target that allows restores;
 *      for a backup the budget (`share.quota_exceeded`); for a copy run the safety rules and the
 *      restore point to copy (or end it "already up to date", 4.10);
 *   3. resolve the server, judge every address and pin one (`share.address_blocked`, 10.1);
 *   4. initialise the repository on the first backup (5.4);
 *   5. open the share password with the tenant key;
 *   6. issue the run credential (5.1, only its hash is stored, it expires at the deadline);
 *   7. `POST /v1/runner/runs` with the share, the credential and the limits.
 *
 * A refusal of the mounter fails the run with the mapped cause (3.6); a mounter that cannot be
 * reached, or whose runner limit is reached, puts the run back into the queue.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  type CopyShareFacts,
  type FailureCause,
  type FileShareSettings,
  RunnerRefusedError,
  type RunnerRunRequest,
  RunnerUnavailableError,
  type ShareSpec,
  checkCopyRules,
  checkMirrorCount,
  cleanTargetFolder,
  fileShareRepositoryPrefix,
  goMemLimitMiB,
  issueRunToken,
  judgeShareAddresses,
  pickCopyRestorePoint,
  resticInit,
  sealSecret,
  shareBudgetBytes,
  shareCause,
  shareCauseOfCode,
  shareQuotaExceeded,
  shareQuotaPercent,
  systemResolver,
  tenantShareBudgetBytes,
  withRepository,
} from "@restow/core";
import {
  type BackupJob,
  type FileShare,
  type FileShareRun,
  backupJobs,
  fileShareReports,
  fileShareRuns,
  fileShareSnapshots,
  fileShares,
  secrets,
  tenants,
} from "@restow/db";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";
import {
  type FileShareDeps,
  keepSharePasswordFile,
  loadFileShareSettings,
  openTenantSecret,
  reportableMessage,
  shareRepositoryAccess,
} from "./common.js";
import { endRun } from "./finish.js";

export const DISPATCH_INTERVAL_MS = 15_000;
const LOCK_KEY = 0x66736431; // "fsd1"
/** Queued runs looked at per pass. */
const CANDIDATES = 100;

export interface DispatchSummary {
  started: number;
  failed: number;
  requeued: number;
  skipped: number;
  upToDate: number;
}

type StartOutcome = "started" | "failed" | "requeued" | "skipped" | "up_to_date";

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  ((error as { code?: string }).code === "23505" ||
    (error as { cause?: { code?: string } }).cause?.code === "23505");

/** One dispatcher pass: start what the limits allow. */
export async function dispatchPass(deps: FileShareDeps): Promise<DispatchSummary> {
  const summary: DispatchSummary = { started: 0, failed: 0, requeued: 0, skipped: 0, upToDate: 0 };
  if (!deps.runner.enabled) {
    return summary;
  }
  const settings = await loadFileShareSettings(deps);
  const active = await deps.providerDb
    .select({ lockShareId: fileShareRuns.lockShareId })
    .from(fileShareRuns)
    .where(inArray(fileShareRuns.status, ["starting", "running"]));
  let capacity = settings.maxConcurrentRunners - active.length;
  if (capacity <= 0) {
    return summary;
  }
  const busy = new Set(active.map((row) => row.lockShareId));
  const queued = await deps.providerDb
    .select({ run: fileShareRuns, tenantStatus: tenants.status })
    .from(fileShareRuns)
    .innerJoin(tenants, eq(tenants.id, fileShareRuns.tenantId))
    .where(eq(fileShareRuns.status, "queued"))
    .orderBy(
      sql`CASE WHEN ${fileShareRuns.kind} = 'restore' THEN 0 ELSE 1 END`,
      asc(fileShareRuns.queuedAt),
      asc(fileShareRuns.id),
    )
    .limit(CANDIDATES);
  for (const { run, tenantStatus } of queued) {
    if (capacity <= 0 || deps.runtime.shutdownSignal.aborted) {
      break;
    }
    if (busy.has(run.lockShareId) || tenantStatus !== "active") {
      summary.skipped++;
      continue;
    }
    let outcome: StartOutcome;
    try {
      outcome = await startRun(deps, run, settings);
    } catch (error) {
      deps.runtime.logger.error("file share run could not be started", {
        runId: run.id,
        errorMessage: reportableMessage(error),
      });
      await endRun(deps, run, {
        status: "failed",
        cause: shareCause("share.runner_failed", { detail: reportableMessage(error) }),
      }).catch(() => undefined);
      outcome = "failed";
    }
    switch (outcome) {
      case "started":
        summary.started++;
        capacity--;
        busy.add(run.lockShareId);
        break;
      case "failed":
        summary.failed++;
        break;
      case "requeued":
        summary.requeued++;
        // The mounter is not there: the next pass tries again.
        return summary;
      case "up_to_date":
        summary.upToDate++;
        break;
      default:
        summary.skipped++;
    }
  }
  return summary;
}

/** Move a queued run to `starting`; false when another dispatcher or run was faster. */
async function claim(deps: FileShareDeps, run: FileShareRun, now: Date): Promise<boolean> {
  try {
    const [row] = await withTenantTx(deps.db, run.tenantId, (tx) =>
      tx
        .update(fileShareRuns)
        .set({ status: "starting", startedAt: now, lastProgressAt: null })
        .where(and(eq(fileShareRuns.id, run.id), eq(fileShareRuns.status, "queued")))
        .returning({ id: fileShareRuns.id }),
    );
    return row !== undefined;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return false;
    }
    throw error;
  }
}

/** Put a claimed run back into the queue (the mounter is not reachable). */
async function requeue(deps: FileShareDeps, run: FileShareRun, note: string): Promise<void> {
  await withTenantTx(deps.db, run.tenantId, (tx) =>
    tx
      .update(fileShareRuns)
      .set({
        status: "queued",
        startedAt: null,
        tokenHash: null,
        tokenExpiresAt: null,
        params: { ...run.params, note },
      })
      .where(and(eq(fileShareRuns.id, run.id), eq(fileShareRuns.status, "starting"))),
  );
}

function fail(deps: FileShareDeps, run: FileShareRun, cause: FailureCause): Promise<StartOutcome> {
  return endRun(deps, run, { status: "failed", cause }).then(() => "failed" as const);
}

async function loadShares(
  deps: FileShareDeps,
  run: FileShareRun,
): Promise<{ source: FileShare | null; target: FileShare | null; job: BackupJob | null }> {
  return withTenantTx(deps.db, run.tenantId, async (tx) => {
    const ids = [...new Set([run.fileShareId, run.lockShareId])];
    const rows = await tx.select().from(fileShares).where(inArray(fileShares.id, ids));
    const job = run.backupJobId
      ? ((
          await tx.select().from(backupJobs).where(eq(backupJobs.id, run.backupJobId)).limit(1)
        )[0] ?? null)
      : null;
    return {
      source: rows.find((row) => row.id === run.fileShareId) ?? null,
      target: rows.find((row) => row.id === run.lockShareId) ?? null,
      job,
    };
  });
}

/** The budget check of a backup (7.4): refused at 100 percent of the share's or tenant's budget. */
async function budgetRefusal(
  deps: FileShareDeps,
  share: FileShare,
  settings: FileShareSettings,
): Promise<FailureCause | null> {
  const shareBudget = shareBudgetBytes(share.quotaGib);
  const tenantBudget = tenantShareBudgetBytes(settings, share.tenantId);
  if (shareBudget === null && tenantBudget === null) {
    return null;
  }
  const [total] = await withTenantTx(deps.db, share.tenantId, (tx) =>
    tx
      .select({ bytes: sql<string | null>`sum(${fileShares.repositoryBytes})` })
      .from(fileShares)
      .where(eq(fileShares.tenantId, share.tenantId)),
  );
  const usage = {
    shareUsed: share.repositoryBytes ?? 0,
    shareBudget,
    tenantUsed: Number(total?.bytes ?? 0),
    tenantBudget,
  };
  if (!shareQuotaExceeded(usage)) {
    return null;
  }
  return shareCause("share.quota_exceeded", {
    params: { count: shareQuotaPercent(usage) ?? 100 },
    detail: `the repository takes ${usage.shareUsed} bytes; budget ${shareBudget ?? "none"}, tenant ${usage.tenantUsed} of ${tenantBudget ?? "none"}`,
  });
}

/** The address to pin for a share (10.1), or the refusal. */
export async function pinnedAddress(
  deps: FileShareDeps,
  share: FileShare,
  settings: FileShareSettings,
): Promise<{ ok: true; address: string } | { ok: false; cause: FailureCause }> {
  const server = share.server.replace(/^\[|\]$/g, "");
  let addresses: readonly string[];
  if (isIP(server) !== 0) {
    addresses = [server];
  } else {
    try {
      addresses = await (deps.resolve ?? systemResolver)(server);
    } catch (error) {
      return {
        ok: false,
        cause: shareCause("share.unreachable", {
          params: { host: share.server },
          detail: `the name ${share.server} does not resolve: ${reportableMessage(error)}`,
        }),
      };
    }
  }
  const decision = judgeShareAddresses(addresses, {
    privateNetworksAllowed: settings.tenantsMayUsePrivateNetworks,
    approval: share.privateNetworkApproval,
  });
  if (decision.ok) {
    return decision;
  }
  if (decision.reason === "unresolvable") {
    return {
      ok: false,
      cause: shareCause("share.unreachable", {
        params: { host: share.server },
        detail: `the name ${share.server} has no address`,
      }),
    };
  }
  return {
    ok: false,
    cause: shareCause("share.address_blocked", {
      params: { host: share.server, reason: decision.reason },
    }),
  };
}

/** The mounter's view of a share (3.2), with the pinned address and the opened password. */
export function shareSpecOf(share: FileShare, address: string, password: string | null): ShareSpec {
  if (share.protocol === "smb") {
    return {
      protocol: "smb",
      server: share.server,
      address,
      share: share.shareName ?? "",
      subfolder: share.subfolder,
      username: share.username ?? "",
      password: password ?? "",
      domain: share.smbDomain,
      smbVersion: share.smbVersion ?? "3.1.1",
      seal: share.smbEncryption,
    };
  }
  return {
    protocol: "nfs",
    server: share.server,
    address,
    export: share.exportPath ?? "",
    subfolder: share.subfolder,
    nfsVersion: share.nfsVersion ?? "4.1",
  };
}

/**
 * Initialise a share's repository before its first backup (5.4): a random password sealed with
 * the tenant key (`file_share_repository`), `restic init` through the loopback listener, the
 * sealed password document next to the repository, `repository_ready_at`.
 */
export async function ensureShareRepository(
  deps: FileShareDeps,
  share: FileShare,
): Promise<FileShare> {
  if (share.repositorySecretId && share.repositoryReadyAt) {
    return share;
  }
  let current = share;
  if (!current.repositorySecretId) {
    const keys = await deps.runtime.keyrings.get(share.tenantId);
    const password = randomBytes(32).toString("base64url");
    const secretId = await withTenantTx(deps.db, share.tenantId, async (tx) => {
      const [locked] = await tx
        .select({ secretId: fileShares.repositorySecretId })
        .from(fileShares)
        .where(eq(fileShares.id, share.id))
        .for("update");
      if (locked?.secretId) {
        return locked.secretId;
      }
      const id = randomUUID();
      await tx.insert(secrets).values({
        id,
        tenantId: share.tenantId,
        kind: "file_share_repository",
        ciphertext: sealSecret(keys.current, id, password),
        keyVersion: keys.current.version,
      });
      await tx
        .update(fileShares)
        .set({ repositorySecretId: id })
        .where(eq(fileShares.id, share.id));
      return id;
    });
    current = { ...current, repositorySecretId: secretId };
  }
  const access = await shareRepositoryAccess(deps, current);
  const exists = await access.storage
    .head(`${fileShareRepositoryPrefix(share.id)}config`)
    .catch(() => null);
  if (!exists) {
    await withRepository(access, (session) => resticInit(session));
  }
  await keepSharePasswordFile(deps, current, access);
  const now = deps.runtime.now();
  await withTenantTx(deps.db, share.tenantId, (tx) =>
    tx.update(fileShares).set({ repositoryReadyAt: now }).where(eq(fileShares.id, share.id)),
  );
  return { ...current, repositoryReadyAt: now };
}

/** A copy run (4.10): the restore point to copy, or why not. */
async function planCopy(
  deps: FileShareDeps,
  run: FileShareRun,
  source: FileShare,
  target: FileShare,
  job: BackupJob | null,
): Promise<
  | { kind: "copy"; snapshotId: string; lastCopiedFileCount: number }
  | { kind: "up_to_date"; snapshotId: string }
  | { kind: "refused"; cause: FailureCause }
> {
  const mode =
    job?.settings.mode ?? (run.params.mode as "overwrite" | "mirror" | undefined) ?? "overwrite";
  const targetFolder = cleanTargetFolder(
    job?.settings.targetFolder ?? (run.params.targetFolder as string | undefined) ?? "",
  );
  const facts = (share: FileShare): CopyShareFacts => ({
    id: share.id,
    protocol: share.protocol,
    server: share.server,
    shareName: share.shareName,
    exportPath: share.exportPath,
    subfolder: share.subfolder,
    allowRestore: share.allowRestore,
    retiredAt: share.retiredAt,
  });
  const rules = checkCopyRules(facts(source), facts(target), { mode, targetFolder });
  if (!rules.ok) {
    return {
      kind: "refused",
      cause: shareCause(rules.code, { params: { reason: rules.rule } }),
    };
  }
  const { snapshots, reports, last } = await withTenantTx(deps.db, run.tenantId, async (tx) => {
    const snapshots = await tx
      .select()
      .from(fileShareSnapshots)
      .where(
        and(eq(fileShareSnapshots.fileShareId, source.id), eq(fileShareSnapshots.status, "active")),
      );
    const reports = await tx
      .select({
        kind: fileShareReports.kind,
        snapshotId: fileShareReports.snapshotId,
        readiness: fileShareReports.readiness,
        checkedAt: fileShareReports.checkedAt,
      })
      .from(fileShareReports)
      .where(
        and(eq(fileShareReports.fileShareId, source.id), eq(fileShareReports.kind, "restore_test")),
      );
    // The restore point the job's last successful run copied.
    const [last] = run.backupJobId
      ? await tx
          .select({ snapshotId: fileShareRuns.sourceSnapshotId, files: fileShareSnapshots.files })
          .from(fileShareRuns)
          .leftJoin(fileShareSnapshots, eq(fileShareSnapshots.id, fileShareRuns.sourceSnapshotId))
          .where(
            and(
              eq(fileShareRuns.backupJobId, run.backupJobId),
              eq(fileShareRuns.trigger, "copy"),
              inArray(fileShareRuns.status, ["succeeded", "warning"]),
              ne(fileShareRuns.id, run.id),
            ),
          )
          .orderBy(desc(fileShareRuns.finishedAt))
          .limit(1)
      : [];
    return { snapshots, reports, last: last ?? null };
  });
  const picked = pickCopyRestorePoint(snapshots, reports);
  if (!picked) {
    return { kind: "refused", cause: shareCause("share.copy_no_verified_point") };
  }
  if (last?.snapshotId === picked.id && run.params.force !== true) {
    return { kind: "up_to_date", snapshotId: picked.id };
  }
  if (mode === "mirror") {
    const count = checkMirrorCount(picked.files, last?.files ?? null, run.params.force === true);
    if (!count.ok) {
      return {
        kind: "refused",
        cause: shareCause(count.code, {
          params: { reason: count.rule, count: picked.files },
        }),
      };
    }
  }
  return { kind: "copy", snapshotId: picked.id, lastCopiedFileCount: last?.files ?? 0 };
}

/** Start one queued run (steps 1 to 7). */
export async function startRun(
  deps: FileShareDeps,
  run: FileShareRun,
  settings: FileShareSettings,
): Promise<StartOutcome> {
  const now = deps.runtime.now();
  if (!(await claim(deps, run, now))) {
    return "skipped";
  }
  const { source, target, job } = await loadShares(deps, run);
  if (!source || !target) {
    return fail(deps, run, shareCause("share.not_found", { detail: "the file share was deleted" }));
  }
  let params = { ...run.params };
  let sourceSnapshotId = run.sourceSnapshotId;
  if (run.kind === "backup") {
    if (source.retiredAt) {
      return fail(
        deps,
        run,
        shareCause("share.copy_unsafe_target", { params: { reason: "retired" } }),
      );
    }
    const refusal = await budgetRefusal(deps, source, settings);
    if (refusal) {
      return fail(deps, run, refusal);
    }
  } else {
    if (!target.allowRestore) {
      return fail(deps, run, shareCause("share.restore_not_allowed"));
    }
    if (run.trigger === "copy") {
      const plan = await planCopy(deps, run, source, target, job);
      if (plan.kind === "refused") {
        return fail(deps, run, plan.cause);
      }
      if (plan.kind === "up_to_date") {
        await withTenantTx(deps.db, run.tenantId, (tx) =>
          tx
            .update(fileShareRuns)
            .set({ sourceSnapshotId: plan.snapshotId })
            .where(eq(fileShareRuns.id, run.id)),
        );
        await endRun(deps, run, {
          status: "succeeded",
          stats: { upToDate: true },
          note: "Already up to date",
        });
        return "up_to_date";
      }
      sourceSnapshotId = plan.snapshotId;
      params = {
        ...params,
        mode: job?.settings.mode ?? params.mode ?? "overwrite",
        targetFolder: cleanTargetFolder(job?.settings.targetFolder ?? params.targetFolder ?? ""),
        mirrorConfirmedAt: job?.settings.mirrorConfirmedAt ?? params.mirrorConfirmedAt ?? null,
        restorePermissions: job?.settings.restorePermissions ?? params.restorePermissions ?? false,
        ...(job?.settings.verify !== undefined ? { verify: job.settings.verify } : {}),
        lastCopiedFileCount: plan.lastCopiedFileCount,
      };
    }
    if (!sourceSnapshotId) {
      return fail(
        deps,
        run,
        shareCause("share.runner_failed", { detail: "no restore point to restore" }),
      );
    }
    if (!source.repositorySecretId) {
      return fail(
        deps,
        run,
        shareCause("share.repository_damaged", { detail: "the source has no repository" }),
      );
    }
  }

  const pinned = await pinnedAddress(deps, target, settings);
  if (!pinned.ok) {
    return fail(deps, run, pinned.cause);
  }

  let repositoryShare = source;
  if (run.kind === "backup") {
    try {
      repositoryShare = await ensureShareRepository(deps, source);
    } catch (error) {
      return fail(
        deps,
        run,
        shareCause("share.repository_damaged", {
          detail: `the repository could not be initialised: ${reportableMessage(error)}`,
        }),
      );
    }
  }

  let password: string | null = null;
  if (target.protocol === "smb") {
    password = target.credentialSecretId
      ? await openTenantSecret(deps, run.tenantId, target.credentialSecretId)
      : null;
    if (!password) {
      return fail(
        deps,
        run,
        shareCause("share.auth_failed", { detail: "no password is stored for the account" }),
      );
    }
  }

  const deadline = new Date(now.getTime() + settings.maxRunHours * 60 * 60 * 1000);
  const { token, hash } = issueRunToken();
  await withTenantTx(deps.db, run.tenantId, (tx) =>
    tx
      .update(fileShareRuns)
      .set({ tokenHash: hash, tokenExpiresAt: deadline, params, sourceSnapshotId })
      .where(and(eq(fileShareRuns.id, run.id), eq(fileShareRuns.status, "starting"))),
  );

  const request: RunnerRunRequest = {
    runId: run.id,
    kind: run.kind,
    mounts: [
      {
        role: run.kind === "backup" ? "source" : "target",
        share: shareSpecOf(target, pinned.address, password),
        readOnly: run.kind === "backup",
      },
    ],
    token,
    limits: {
      memoryMiB: settings.runnerMemoryMiB,
      goMemLimitMiB: goMemLimitMiB(settings),
      deadline: deadline.toISOString(),
      cacheKey: repositoryShare.id,
    },
  };
  try {
    await deps.runner.start(request);
  } catch (error) {
    if (error instanceof RunnerUnavailableError) {
      await requeue(deps, run, "Waiting for the mounter");
      deps.runtime.logger.warn("the mounter is not reachable; file share runs wait", {
        reason: error.reason,
      });
      return "requeued";
    }
    if (error instanceof RunnerRefusedError) {
      if (error.code === "runner.limit") {
        await requeue(deps, run, "Waiting for a free runner");
        return "requeued";
      }
      if (error.code === "exists") {
        // A container for this run exists already (a dispatcher that died after starting it):
        // the monitor follows it up.
        return "started";
      }
      const secretsToHide = password ? [password] : [];
      return fail(deps, run, shareCauseOfCode(error.code, error.detail, secretsToHide));
    }
    throw error;
  }
  deps.runtime.logger.info("file share run started", {
    tenantId: run.tenantId,
    runId: run.id,
    kind: run.kind,
    fileShareId: run.fileShareId,
  });
  return "started";
}

/** Run a pass every 15 seconds while no other worker does; returns a stop function. */
export function startFileShareDispatcher(
  deps: FileShareDeps,
  intervalMs = DISPATCH_INTERVAL_MS,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async () => {
    const client = await deps.providerDb.$client.connect().catch(() => null);
    if (!client) {
      if (!stopped) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
      return;
    }
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [LOCK_KEY],
      );
      if (!rows[0]?.locked) {
        return;
      }
      try {
        const summary = await dispatchPass(deps);
        if (summary.started + summary.failed + summary.requeued + summary.upToDate > 0) {
          deps.runtime.logger.info("file share dispatcher pass", { ...summary });
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
      }
    } catch (error) {
      deps.runtime.logger.error("file share dispatcher pass failed", {
        errorMessage: reportableMessage(error),
      });
    } finally {
      client.release();
      if (!stopped) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    }
  };
  timer = setTimeout(() => void tick(), Math.min(intervalMs, 5_000));
  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
  deps.runtime.shutdownSignal.addEventListener("abort", stop, { once: true });
  return stop;
}
