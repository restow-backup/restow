import {
  FILE_SHARE_QUEUES,
  type FileShareFinishPayload,
  type ShareSession,
  backupSession,
  bandwidthTimeZone,
  fileShareSingletonKey,
  parseBasicAuthorization,
  redactSensitiveText,
  secretMatchesHash,
  shareRepositoryUrl,
  shareRunCause,
  toFailureRecord,
} from "@restow/core";
import {
  type BackupJob,
  type BackupJobMember,
  type FileShare,
  type FileShareRun,
  backupJobMembers,
  backupJobs,
  fileShareRunItems,
  fileShareRuns,
  fileShareSamples,
  fileShareSnapshots,
  fileShares,
  recordRunSample,
  samplePoint,
  tenants,
} from "@restow/db";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { db, providerDb } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { readSecret } from "../../lib/secrets.js";
import { type Transaction, isUuid, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody } from "../../schemas.js";
import { authFailures } from "../endpoints/agent-auth.js";
import { jobQueue } from "../jobs/queue.js";
import { FILE_SHARE_PROBLEMS } from "./constants.js";
import { fileShareSettings } from "./settings.js";

/**
 * /internal/file-shares/v1: the routes restow-share calls during a run (docs/FILESHARES.md 5.2).
 * Like the restic route they are reached over the internal `runners` network only: Caddy never
 * forwards /internal, and a request that came through a proxy (`X-Forwarded-For`, `Forwarded`,
 * `Via`) is answered 404. The caller authenticates with its run's credential (HTTP Basic
 * `<runId>:<token>`, 5.1), valid while the run is starting or running, its tenant active and
 * its deadline ahead; failed credentials count against the agent routes' per-address limiter.
 *
 *   GET  /session    the run's parameters; moves it from starting to running
 *   POST /progress   progress (every 5 s); the answer carries a cancel requested in Restow
 *   POST /items      per-file problems, at most 500 per request, 10,000 kept per run
 *   POST /samples    the hashed sample files of a backup (at most 20)
 *   POST /finish     the result; ends the credential; idempotent for the same report
 *
 * The finish route records the result and hands the heavy part (the restore point row, the
 * share's columns, alerts and webhooks) to the worker (`file-share-finish`, 8.3); a finish whose
 * job could not be queued is picked up by the monitor.
 */
export const fileShareRunnerRoutes = new Hono();

const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "forwarded", "via"];
/** How long after its end a run may repeat its finish report (a lost answer). */
const FINISH_REPEAT_MS = 15 * 60 * 1000;
export const MAX_ITEMS_PER_REQUEST = 500;
export const MAX_ITEMS_PER_RUN = 10_000;
const MAX_SAMPLES = 20;

type RunRow = FileShareRun & { tenantStatus: string };

function unauthorized(c: Context): ProblemError {
  c.header("www-authenticate", 'Basic realm="restow-share"');
  return new ProblemError(401, "Unauthorized", { detail: "The run credential is not valid." });
}

/**
 * The run of the presented credential. `finished` also lets a run that ended in the last
 * minutes through (the repeated finish report), nothing else does.
 */
async function authenticateRun(c: Context, options: { finished?: boolean } = {}): Promise<RunRow> {
  if (PROXY_HEADERS.some((name) => c.req.header(name) !== undefined)) {
    throw new ProblemError(404, "Not found");
  }
  const now = Date.now();
  const key = clientIp(c) ?? "unknown";
  if (authFailures.isBlocked(key, now)) {
    throw new ProblemError(429, "Too many requests", { type: "urn:restow:problem:rate-limited" });
  }
  const credentials = parseBasicAuthorization(c.req.header("authorization"));
  if (!credentials || !isUuid(credentials.username)) {
    authFailures.record(key, now);
    throw unauthorized(c);
  }
  const [row] = await providerDb
    .select({ run: fileShareRuns, tenantStatus: tenants.status })
    .from(fileShareRuns)
    .innerJoin(tenants, eq(tenants.id, fileShareRuns.tenantId))
    .where(eq(fileShareRuns.id, credentials.username))
    .limit(1);
  if (!row?.run.tokenHash || !secretMatchesHash(credentials.password, row.run.tokenHash)) {
    authFailures.record(key, now);
    throw unauthorized(c);
  }
  const run = { ...row.run, tenantStatus: row.tenantStatus };
  const live =
    (run.status === "starting" || run.status === "running") &&
    run.tokenExpiresAt !== null &&
    run.tokenExpiresAt.getTime() > now &&
    run.tenantStatus === "active";
  const repeat =
    options.finished === true &&
    run.finishedAt !== null &&
    now - run.finishedAt.getTime() < FINISH_REPEAT_MS;
  if (!live && !repeat) {
    throw new ProblemError(401, "Credential expired", {
      type: FILE_SHARE_PROBLEMS.runFinished,
      detail: "The run of this credential has ended.",
    });
  }
  return run;
}

async function loadShare(tx: Transaction, id: string): Promise<FileShare> {
  const [share] = await tx.select().from(fileShares).where(eq(fileShares.id, id)).limit(1);
  if (!share) {
    throw new ProblemError(409, "Share gone", { detail: "The file share of this run is gone." });
  }
  return share;
}

/** The share job a share is a member of, with the member row (its overrides). */
async function jobOfShare(
  tx: Transaction,
  shareId: string,
): Promise<{ job: BackupJob | null; member: BackupJobMember | null }> {
  const [row] = await tx
    .select({ member: backupJobMembers, job: backupJobs })
    .from(backupJobMembers)
    .innerJoin(backupJobs, eq(backupJobs.id, backupJobMembers.jobId))
    .where(and(eq(backupJobMembers.fileShareId, shareId), eq(backupJobs.kind, "share")))
    .limit(1);
  return { job: row?.job ?? null, member: row?.member ?? null };
}

/** `Host` as the runner reached the api (`api:3000`), for the repository URL it gets. */
function apiBaseUrl(c: Context): string {
  const host = c.req.header("host") ?? "";
  return /^[A-Za-z0-9.:[\]-]{1,255}$/.test(host) ? `http://${host}` : "http://api:3000";
}

async function buildSession(tx: Transaction, run: RunRow, baseUrl: string): Promise<ShareSession> {
  const source = await loadShare(tx, run.fileShareId);
  const mounted = run.lockShareId === source.id ? source : await loadShare(tx, run.lockShareId);
  if (!source.repositorySecretId) {
    throw new ProblemError(409, "Repository missing", {
      detail: "The repository of this file share is not initialised.",
    });
  }
  const repositoryPassword = await readSecret(tx, {
    id: source.repositorySecretId,
    tenantId: run.tenantId,
  });
  if (repositoryPassword === null) {
    throw new ProblemError(409, "Repository missing", {
      detail: "The repository password of this file share is not available.",
    });
  }
  const session: ShareSession = {
    run: {
      id: run.id,
      kind: run.kind,
      shareId: source.id,
      deadline: (run.tokenExpiresAt as Date).toISOString(),
    },
    expect: { protocol: mounted.protocol, readOnly: run.kind === "backup" },
    repository: { url: shareRepositoryUrl(baseUrl, source.id), repositoryPassword },
  };
  if (run.kind === "backup") {
    const { job, member } = await jobOfShare(tx, source.id);
    const [previous] = await tx
      .select({
        resticSnapshotId: fileShareSnapshots.resticSnapshotId,
        files: fileShareSnapshots.files,
      })
      .from(fileShareSnapshots)
      .where(
        and(eq(fileShareSnapshots.fileShareId, source.id), eq(fileShareSnapshots.status, "active")),
      )
      .orderBy(desc(fileShareSnapshots.sequence))
      .limit(1);
    const [done] = await tx
      .select({ n: count() })
      .from(fileShareSnapshots)
      .where(eq(fileShareSnapshots.fileShareId, source.id));
    const [tenant] = await tx
      .select({ timeZone: tenants.timeZone })
      .from(tenants)
      .where(eq(tenants.id, run.tenantId));
    const overrides = member?.overrides ?? {};
    session.backup = backupSession({
      settings: { ...(job?.settings ?? {}), ...overrides },
      includes: overrides.includes ?? [],
      installation: await fileShareSettings(),
      share: {
        protocol: source.protocol,
        permissionsMode: source.permissionsMode,
        rereadPermissions: source.rereadPermissions,
        allowEmptyOnce: source.allowEmptyOnce,
      },
      previous: previous ?? null,
      backupsSoFar: Number(done?.n ?? 0),
      timeZone: bandwidthTimeZone(
        overrides.schedule?.timeZone,
        job?.schedule?.timeZone,
        tenant?.timeZone,
      ),
      now: new Date(),
      allowEmptyOnce: run.params.allowEmptyOnce === true,
    });
    return session;
  }
  const params = run.params;
  let snapshotId = "";
  if (run.sourceSnapshotId) {
    const [snap] = await tx
      .select({ resticSnapshotId: fileShareSnapshots.resticSnapshotId })
      .from(fileShareSnapshots)
      .where(eq(fileShareSnapshots.id, run.sourceSnapshotId))
      .limit(1);
    snapshotId = snap?.resticSnapshotId ?? "";
  }
  if (!snapshotId) {
    throw new ProblemError(409, "Restore point missing", {
      detail: "The restore point of this run is gone.",
    });
  }
  const copy = run.trigger === "copy";
  session.restore = {
    snapshotId,
    paths: params.paths ?? [],
    destination: copy ? "folder" : (params.destination ?? "new_folder"),
    folder: (copy ? params.targetFolder : params.folder) ?? "",
    conflict: params.conflict ?? "",
    restorePermissions: params.restorePermissions === true,
    verify: params.verify ?? mounted.protocol === "nfs",
    targetShareId: mounted.id,
    ...(copy
      ? {
          copy: {
            jobId: run.backupJobId ?? "",
            sourceShareId: source.id,
            mode: params.mode ?? "overwrite",
            mirrorConfirmed: Boolean(params.mirrorConfirmedAt),
            lastCopiedFileCount:
              typeof params.lastCopiedFileCount === "number" ? params.lastCopiedFileCount : 0,
            force: params.force === true,
          },
        }
      : {}),
  };
  return session;
}

fileShareRunnerRoutes.get("/session", async (c) => {
  const run = await authenticateRun(c);
  const baseUrl = apiBaseUrl(c);
  const session = await withTenantTx(db, run.tenantId, async (tx) => {
    const built = await buildSession(tx, run, baseUrl);
    const now = new Date();
    await tx
      .update(fileShareRuns)
      .set({
        status: "running",
        lastProgressAt: now,
        // What the restore point will cover, for its row (file_share_snapshots.includes).
        ...(built.backup ? { params: { ...run.params, includes: built.backup.includes } } : {}),
      })
      .where(
        and(eq(fileShareRuns.id, run.id), inArray(fileShareRuns.status, ["starting", "running"])),
      );
    return built;
  });
  c.header("cache-control", "no-store");
  return c.json(session);
});

const count64 = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const progressSchema = z.object({
  phase: z.string().max(32),
  filesDone: count64,
  bytesDone: count64,
  totalFiles: count64,
  totalBytes: count64,
  currentPath: z.string().max(4096).default(""),
  bytesUploaded: count64.default(0),
  at: z.string().max(64).optional(),
});

fileShareRunnerRoutes.post("/progress", async (c) => {
  const run = await authenticateRun(c);
  const input = await parseJsonBody(c.req, progressSchema);
  const now = new Date();
  const cancel = await withTenantTx(db, run.tenantId, async (tx) => {
    const [row] = await tx
      .update(fileShareRuns)
      .set({
        progress: {
          phase: input.phase,
          filesDone: input.filesDone,
          bytesDone: input.bytesDone,
          totalFiles: input.totalFiles,
          totalBytes: input.totalBytes,
          currentPath: redactSensitiveText(input.currentPath).slice(0, 1024),
          bytesUploaded: input.bytesUploaded,
          at: now.toISOString(),
        },
        lastProgressAt: now,
        // A runner that reports progress has its session: it is running.
        status: "running",
      })
      .where(
        and(eq(fileShareRuns.id, run.id), inArray(fileShareRuns.status, ["starting", "running"])),
      )
      .returning({ cancelRequestedAt: fileShareRuns.cancelRequestedAt });
    await recordRunSample(
      tx,
      { tenantId: run.tenantId, fileShareRunId: run.id },
      samplePoint(now.getTime(), input.bytesDone, input.bytesUploaded),
    );
    return row?.cancelRequestedAt != null;
  });
  return c.json({ cancel });
});

const itemsSchema = z.object({
  items: z
    .array(
      z.object({
        path: z.string().max(4096).default(""),
        code: z.string().min(1).max(64),
        message: z.string().max(4000).default(""),
        phase: z.string().max(32).default(""),
      }),
    )
    .max(MAX_ITEMS_PER_REQUEST),
});

fileShareRunnerRoutes.post("/items", async (c) => {
  const run = await authenticateRun(c);
  const { items } = await parseJsonBody(c.req, itemsSchema);
  if (items.length === 0) {
    return c.body(null, 204);
  }
  await withTenantTx(db, run.tenantId, async (tx) => {
    const [row] = await tx
      .select({ stored: fileShareRuns.itemsStored })
      .from(fileShareRuns)
      .where(eq(fileShareRuns.id, run.id))
      .for("update");
    const room = Math.max(0, MAX_ITEMS_PER_RUN - (row?.stored ?? 0));
    const kept = items.slice(0, room);
    if (kept.length > 0) {
      await tx.insert(fileShareRunItems).values(
        kept.map((item) => ({
          tenantId: run.tenantId,
          runId: run.id,
          path: item.path,
          code: item.code,
          phase: item.phase,
          message: redactSensitiveText(item.message).slice(0, 500),
        })),
      );
    }
    await tx
      .update(fileShareRuns)
      .set({
        itemCount: sql`${fileShareRuns.itemCount} + ${items.length}`,
        itemsStored: sql`${fileShareRuns.itemsStored} + ${kept.length}`,
      })
      .where(eq(fileShareRuns.id, run.id));
  });
  return c.body(null, 204);
});

const resticId = z.string().regex(/^[0-9a-f]{8,64}$/);
const samplesSchema = z.object({
  snapshotId: resticId,
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(4096),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: count64,
      }),
    )
    .max(MAX_SAMPLES),
});

fileShareRunnerRoutes.post("/samples", async (c) => {
  const run = await authenticateRun(c);
  if (run.kind !== "backup") {
    throw new ProblemError(409, "Not a backup", { detail: "Only a backup run has samples." });
  }
  const input = await parseJsonBody(c.req, samplesSchema);
  if (input.files.length > 0) {
    await withTenantTx(db, run.tenantId, (tx) =>
      tx
        .insert(fileShareSamples)
        .values(
          input.files.map((file) => ({
            tenantId: run.tenantId,
            fileShareId: run.fileShareId,
            runId: run.id,
            snapshotId: input.snapshotId,
            path: file.path,
            sha256: file.sha256,
            size: file.size,
          })),
        )
        .onConflictDoNothing(),
    );
  }
  return c.body(null, 204);
});

const finishSchema = z.object({
  status: z.enum(["succeeded", "warning", "failed", "cancelled"]),
  code: z.string().max(64).optional(),
  message: z.string().max(8000).optional(),
  snapshotId: resticId.optional(),
  stats: z.record(z.unknown()).default({}),
  restore: z.record(z.unknown()).optional(),
  logTail: z.string().max(64_000).default(""),
});

type FinishInput = z.infer<typeof finishSchema>;

/** Whether a stored finish is the one now reported again. */
function sameFinish(run: FileShareRun, input: FinishInput): boolean {
  return (
    run.status === input.status &&
    run.stats.resticSnapshotId === input.snapshotId &&
    run.stats.finishCode === input.code
  );
}

/** Strip what a log or message must never carry: credentials and the repository password. */
function clean(text: string, secrets: readonly string[], max: number): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      out = out.split(secret).join("***");
    }
  }
  return redactSensitiveText(out, max).slice(-max);
}

fileShareRunnerRoutes.post("/finish", async (c) => {
  const run = await authenticateRun(c, { finished: true });
  const input = await parseJsonBody(c.req, finishSchema);
  if (run.finishedAt !== null) {
    if (sameFinish(run, input)) {
      return c.json({ recorded: true, repeated: true });
    }
    throw new ProblemError(409, "Run already finished", {
      type: FILE_SHARE_PROBLEMS.runFinished,
      detail: "This run reported a different result before.",
    });
  }
  const now = new Date();
  const items = (input.stats.items ?? {}) as Record<string, number>;
  const recorded = await withTenantTx(db, run.tenantId, async (tx) => {
    const share = await loadShare(tx, run.fileShareId);
    const repositoryPassword = share.repositorySecretId
      ? await readSecret(tx, { id: share.repositorySecretId, tenantId: run.tenantId })
      : null;
    const secrets = repositoryPassword ? [repositoryPassword] : [];
    const cause = shareRunCause(
      { status: input.status, code: input.code, message: input.message, items },
      secrets,
    );
    const [updated] = await tx
      .update(fileShareRuns)
      .set({
        status: input.status,
        finishedAt: now,
        lastProgressAt: now,
        stats: {
          ...input.stats,
          ...(input.snapshotId ? { resticSnapshotId: input.snapshotId } : {}),
          ...(input.restore ? { restore: input.restore } : {}),
          ...(input.code ? { finishCode: input.code } : {}),
        },
        failure: cause ? toFailureRecord(cause, { now, step: "runner" }) : null,
        errorMessage:
          input.status === "failed" && input.message ? clean(input.message, secrets, 2000) : null,
        logTail: clean(input.logTail, secrets, 8000),
      })
      .where(
        and(eq(fileShareRuns.id, run.id), inArray(fileShareRuns.status, ["starting", "running"])),
      )
      .returning({ id: fileShareRuns.id });
    return updated !== undefined;
  });
  if (!recorded) {
    throw new ProblemError(409, "Run already finished", {
      type: FILE_SHARE_PROBLEMS.runFinished,
      detail: "This run ended before its report arrived.",
    });
  }
  const payload: FileShareFinishPayload = { tenantId: run.tenantId, runId: run.id };
  try {
    await jobQueue(db).send(FILE_SHARE_QUEUES.finish, payload, {
      singletonKey: fileShareSingletonKey(FILE_SHARE_QUEUES.finish, run.id),
    });
  } catch {
    // The monitor processes a finish nobody queued (8.3).
  }
  return c.json({ recorded: true });
});
