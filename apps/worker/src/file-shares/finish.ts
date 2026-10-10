/**
 * The end of a file share run on the server (docs/FILESHARES.md 8.3). The api's finish route
 * records what the runner reported and queues `file-share-finish`; the dispatcher and the
 * monitor end runs that never got that far. Either way this module does the rest, once per run
 * (`finish_processed_at`):
 *
 *   - a successful backup becomes a restore point (`file_share_snapshots`, the next sequence of
 *     the share) and moves the share's columns (`last_success_at`, `last_snapshot_id`, the
 *     credential warning cleared, `allow_empty_once` used up);
 *   - a refused password marks the share (`credential_failed_at`) so the page asks for the new
 *     one;
 *   - failures raise `backup.failed` / `restore.failed`, a finished restore `restore.completed`
 *     (a copy only when it copied something), with the share as the subject (section 14);
 *   - the webhooks `job.completed` / `job.failed` with `data.job.queue` `file-share-backup`,
 *     `file-share-restore` or `file-share-copy` and `data.fileShare`.
 */
import {
  FILE_SHARE_QUEUES,
  type FailureCause,
  type FileShareJobPayload,
  fileShareSingletonKey,
  shareCause,
  summarizeFailure,
  toFailureRecord,
} from "@restow/core";
import {
  type FileShare,
  type FileShareRun,
  type NewNotification,
  fileShareRuns,
  fileShareSnapshots,
  fileShares,
} from "@restow/db";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";
import { emitWebhookEvent } from "../handlers/webhooks.js";
import { raiseEvents } from "../reporting.js";
import type { FileShareDeps } from "./common.js";

const OPEN_STATUSES = ["queued", "starting", "running"] as const;

/** The webhook queue name of a run (section 14). */
export function runQueueName(run: Pick<FileShareRun, "kind" | "trigger">): string {
  if (run.trigger === "copy") {
    return "file-share-copy";
  }
  return run.kind === "backup" ? "file-share-backup" : "file-share-restore";
}

/**
 * End a run the runner did not end itself (it never started, it vanished, it was refused before
 * it ran): `failed` with the cause, or `cancelled`. Returns false when the run had ended already.
 * The finish is processed at once.
 */
export async function endRun(
  deps: FileShareDeps,
  run: Pick<FileShareRun, "id" | "tenantId">,
  outcome:
    | { status: "failed"; cause: FailureCause; message?: string | null; logTail?: string | null }
    | { status: "cancelled"; message?: string | null }
    | { status: "succeeded"; stats?: Record<string, unknown>; note?: string },
  now: Date = deps.runtime.now(),
): Promise<boolean> {
  const ended = await withTenantTx(deps.db, run.tenantId, async (tx) => {
    const [current] = await tx
      .select({ stats: fileShareRuns.stats, params: fileShareRuns.params })
      .from(fileShareRuns)
      .where(eq(fileShareRuns.id, run.id))
      .limit(1);
    const failure =
      outcome.status === "failed" ? toFailureRecord(outcome.cause, { now, step: "server" }) : null;
    const [row] = await tx
      .update(fileShareRuns)
      .set({
        status: outcome.status,
        finishedAt: now,
        // The credential ends with the run (5.1).
        tokenHash: null,
        failure,
        errorMessage:
          outcome.status === "failed"
            ? (outcome.message ?? summarizeFailure(outcome.cause)).slice(0, 2000)
            : outcome.status === "cancelled"
              ? (outcome.message ?? null)
              : null,
        ...(outcome.status === "failed" && outcome.logTail ? { logTail: outcome.logTail } : {}),
        ...(outcome.status === "succeeded"
          ? {
              stats: { ...(current?.stats ?? {}), ...(outcome.stats ?? {}) },
              params: {
                ...(current?.params ?? {}),
                ...(outcome.note ? { note: outcome.note } : {}),
              },
            }
          : {}),
      })
      .where(and(eq(fileShareRuns.id, run.id), inArray(fileShareRuns.status, [...OPEN_STATUSES])))
      .returning({ id: fileShareRuns.id });
    return row !== undefined;
  });
  if (ended) {
    await processFinish(deps, run.tenantId, run.id, now);
  }
  return ended;
}

interface Processed {
  run: FileShareRun;
  share: FileShare;
  notify: boolean;
}

/**
 * Process a run's finish once. Returns false when there was nothing to do (not finished yet,
 * processed already, gone).
 */
export async function processFinish(
  deps: FileShareDeps,
  tenantId: string,
  runId: string,
  now: Date = deps.runtime.now(),
): Promise<boolean> {
  const processed = await withTenantTx(deps.db, tenantId, async (tx): Promise<Processed | null> => {
    const [locked] = await tx
      .select()
      .from(fileShareRuns)
      .where(eq(fileShareRuns.id, runId))
      .for("update");
    if (!locked || locked.finishedAt === null || locked.finishProcessedAt !== null) {
      return null;
    }
    let run = locked;
    const [share] = await tx
      .select()
      .from(fileShares)
      .where(eq(fileShares.id, run.fileShareId))
      .limit(1);
    if (!share) {
      return null;
    }
    const finishedAt = run.finishedAt as Date;
    const runUpdate: Partial<FileShareRun> = { finishProcessedAt: now };

    if (run.kind === "backup") {
      const resticId =
        typeof run.stats.resticSnapshotId === "string" ? run.stats.resticSnapshotId : null;
      const succeeded = run.status === "succeeded" || run.status === "warning";
      // The empty-source guard on the server's side too (4.3): an empty restore point after one
      // with files is no success unless the admin allowed it once. The runner refuses before it
      // backs up; this catches a runner that did not, so the empty point never becomes the
      // newest good one (retention keeps the last point with files anyway, 8.4).
      const emptied =
        succeeded &&
        resticId !== null &&
        run.stats.files === 0 &&
        !share.allowEmptyOnce &&
        run.params.allowEmptyOnce !== true &&
        (await previousFiles(tx, share.id)) > 0;
      if (succeeded && (!resticId || emptied)) {
        // A success without a restore point is none.
        const cause = emptied
          ? shareCause("share.empty_source", {
              detail: "the runner reported an empty restore point after one with files",
            })
          : shareCause("share.runner_failed", {
              detail: "the runner reported success without a restore point",
            });
        run = {
          ...run,
          status: "failed",
          failure: toFailureRecord(cause, { now, step: "server" }),
          errorMessage: summarizeFailure(cause),
        };
        Object.assign(runUpdate, {
          status: run.status,
          failure: run.failure,
          errorMessage: run.errorMessage,
        });
      }
      if ((run.status === "succeeded" || run.status === "warning") && resticId) {
        const snapshotId = await recordSnapshot(tx, run, share, resticId, finishedAt);
        runUpdate.snapshotId = snapshotId;
        await tx
          .update(fileShares)
          .set({
            lastBackupAt: finishedAt,
            lastSuccessAt: finishedAt,
            lastSnapshotId: snapshotId,
            allowEmptyOnce: false,
            credentialFailedAt: null,
          })
          .where(eq(fileShares.id, share.id));
      } else if (run.status === "failed") {
        await tx
          .update(fileShares)
          .set({
            lastBackupAt: finishedAt,
            ...(run.failure?.code === "share.auth_failed" ? { credentialFailedAt: now } : {}),
          })
          .where(eq(fileShares.id, share.id));
      }
    } else {
      // A restore marks the share it mounted: the target.
      if (run.failure?.code === "share.auth_failed") {
        await tx
          .update(fileShares)
          .set({ credentialFailedAt: now })
          .where(eq(fileShares.id, run.lockShareId));
      } else if (run.status === "succeeded" || run.status === "warning") {
        await tx
          .update(fileShares)
          .set({ credentialFailedAt: null })
          .where(eq(fileShares.id, run.lockShareId));
      }
    }

    const events = eventsOf(run, share);
    if (events.length > 0) {
      await raiseEvents(tx, events, now);
      runUpdate.alertedAt = now;
    }
    await tx.update(fileShareRuns).set(runUpdate).where(eq(fileShareRuns.id, run.id));
    return { run: { ...run, ...runUpdate } as FileShareRun, share, notify: true };
  });
  if (!processed) {
    return false;
  }
  await emitRunWebhook(deps, processed.run, processed.share).catch((error) =>
    deps.runtime.logger.warn("file share webhook could not be queued", {
      runId,
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error),
    }),
  );
  if (processed.run.kind === "backup" && processed.run.snapshotId && deps.boss) {
    const payload: FileShareJobPayload = {
      tenantId,
      fileShareId: processed.share.id,
      snapshotId: processed.run.snapshotId,
    };
    await deps.boss
      .send(FILE_SHARE_QUEUES.catalog, payload, {
        singletonKey: fileShareSingletonKey(FILE_SHARE_QUEUES.catalog, processed.share.id),
      })
      .catch(() => undefined);
  }
  return true;
}

type Tx = Parameters<Parameters<typeof withTenantTx>[2]>[0];

/** The file count of the share's newest active restore point; 0 without one. */
async function previousFiles(tx: Tx, shareId: string): Promise<number> {
  const [row] = await tx
    .select({ files: fileShareSnapshots.files })
    .from(fileShareSnapshots)
    .where(
      and(eq(fileShareSnapshots.fileShareId, shareId), eq(fileShareSnapshots.status, "active")),
    )
    .orderBy(desc(fileShareSnapshots.sequence))
    .limit(1);
  return row?.files ?? 0;
}

/** The restore point of a successful backup (idempotent: an existing row is reused). */
async function recordSnapshot(
  tx: Tx,
  run: FileShareRun,
  share: FileShare,
  resticId: string,
  finishedAt: Date,
): Promise<string> {
  const [existing] = await tx
    .select({ id: fileShareSnapshots.id })
    .from(fileShareSnapshots)
    .where(
      and(
        eq(fileShareSnapshots.fileShareId, share.id),
        eq(fileShareSnapshots.resticSnapshotId, resticId),
      ),
    )
    .limit(1);
  if (existing) {
    return existing.id;
  }
  const [top] = await tx
    .select({ sequence: max(fileShareSnapshots.sequence) })
    .from(fileShareSnapshots)
    .where(eq(fileShareSnapshots.fileShareId, share.id));
  const stats = run.stats;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const permissions = (stats.permissions ?? null) as Record<string, unknown> | null;
  const [row] = await tx
    .insert(fileShareSnapshots)
    .values({
      tenantId: run.tenantId,
      fileShareId: share.id,
      runId: run.id,
      sequence: (top?.sequence ?? 0) + 1,
      resticSnapshotId: resticId,
      snapshotTime: finishedAt,
      includes: Array.isArray(run.params.includes) ? (run.params.includes as string[]) : [],
      files: num(stats.files),
      dirs: num(stats.dirs),
      bytes: num(stats.bytes),
      bytesAdded: num(stats.dataAdded),
      permissions: permissions
        ? {
            mode: String(permissions.mode ?? ""),
            xattr: String(permissions.xattr ?? ""),
            entries: num(permissions.entries),
            descriptors: num(permissions.descriptors),
            errors: num(permissions.errors),
          }
        : null,
    })
    .returning({ id: fileShareSnapshots.id });
  return row?.id as string;
}

/** The notifications a finished run raises (section 14). */
export function eventsOf(run: FileShareRun, share: FileShare): NewNotification[] {
  const base = {
    fileShareId: share.id,
    objectName: share.name,
    runId: run.id,
    completedAt: run.finishedAt?.toISOString() ?? null,
    ...(run.backupJobId ? { backupJobId: run.backupJobId } : {}),
  };
  const reason = run.errorMessage ?? null;
  if (run.status === "failed") {
    const backup = run.kind === "backup";
    const what = backup ? "backup" : run.trigger === "copy" ? "copy" : "restore";
    return [
      {
        tenantId: run.tenantId,
        level: "error",
        event: backup ? "backup.failed" : "restore.failed",
        message: `The ${what} of the file share ${share.name} failed${reason ? `: ${reason.slice(0, 300)}` : "."}`,
        details: {
          ...base,
          errorMessage: reason ? reason.slice(0, 500) : null,
          failureCode: run.failure?.code ?? null,
        },
      },
    ];
  }
  if (run.kind === "restore" && (run.status === "succeeded" || run.status === "warning")) {
    const restore = (run.stats.restore ?? {}) as Record<string, unknown>;
    const copied =
      Number(restore.restored ?? 0) + Number(restore.deleted ?? 0) + Number(restore.renamed ?? 0);
    if (run.trigger === "copy" && (run.stats.upToDate === true || copied === 0)) {
      return [];
    }
    return [
      {
        tenantId: run.tenantId,
        level: "info",
        event: "restore.completed",
        message:
          run.trigger === "copy"
            ? `The copy of the file share ${share.name} finished.`
            : `The restore from the file share ${share.name} finished.`,
        details: { ...base, restored: Number(restore.restored ?? 0) },
      },
    ];
  }
  return [];
}

/** `job.completed` / `job.failed` for a run that ended (cancelled runs raise none). */
export async function emitRunWebhook(
  deps: FileShareDeps,
  run: FileShareRun,
  share: Pick<FileShare, "id" | "name" | "protocol">,
): Promise<void> {
  const failed = run.status === "failed";
  if (!failed && run.status !== "succeeded" && run.status !== "warning") {
    return;
  }
  const duration =
    run.startedAt && run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null;
  await emitWebhookEvent(deps.db, {
    tenantId: run.tenantId,
    event: failed ? "job.failed" : "job.completed",
    occurredAt: run.finishedAt ?? undefined,
    data: {
      job: {
        id: run.id,
        queue: runQueueName(run),
        status: failed ? "failed" : "completed",
        protectedObjectId: null,
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.finishedAt?.toISOString() ?? null,
        durationMs: duration,
        errorMessage: failed ? run.errorMessage : null,
        failure: failed ? (run.failure ?? null) : null,
      },
      fileShare: { id: share.id, name: share.name, protocol: share.protocol },
    },
  });
}
