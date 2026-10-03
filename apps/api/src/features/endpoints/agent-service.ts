import { randomBytes, randomUUID } from "node:crypto";
import {
  type AgentConfigResponse,
  DEFAULT_SCHEDULE_TIMEZONE,
  RESTIC_VERSION,
  type RestoreTestTaskParams,
  agentFacingConfig,
  bandwidthTimeZone,
  effectiveBandwidthKbps,
  endpointPasswordKey,
  enrolledEndpointConfig,
  enrollmentTokenState,
  failureOfRun,
  generateAgentSecret,
  hashSecret,
  isInterruptedOnly,
  isSupportedEndpointOs,
  isValidTimeZone,
  judgeAgentRestoreTest,
  redactAgentLog,
  redactAgentMessage,
  resticInit,
  restoreTestAlreadyWaiting,
  restoreTestRetry,
  sealEndpointPassword,
  toFailureRecord,
} from "@restow/core";
import {
  type Endpoint,
  type EndpointConfig,
  type EndpointRun,
  endpointEnrollmentTokens,
  endpointReports,
  endpointRuns,
  endpointSamples,
  endpointTasks,
  endpoints,
  tenants,
} from "@restow/db";
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, providerDb } from "../../db.js";
import { loadTenantDek, storeSecret } from "../../lib/secrets.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { emitWebhookEvent } from "../../lib/webhooks.js";
import { ProblemError } from "../../problem.js";
import { type AgentContext, FailureTracker } from "./agent-auth.js";
import { ENDPOINT_AUDIT_ACTIONS, agentActor, auditEndpoint } from "./audit.js";
import { compareAgentVersions, isAgentVersion, latestAgentRelease } from "./distribution.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import {
  REPOSITORY_SECRET_KIND,
  forgetTenantStorage,
  removeRepositoryObjects,
  removeSecret,
  repositoryAccess,
  tenantStorage,
  withRepository,
} from "./repository.js";
import { resticProblem } from "./restic-problem.js";
import { recordProgressSample, startRunSamples } from "./run-samples.js";
import {
  type EnrollInput,
  type FinishRunInput,
  type HeartbeatInput,
  MAX_ERRORS,
  MAX_LOG_TAIL_BYTES,
  type ProgressInput,
  type StartRunInput,
} from "./schemas.js";

/**
 * The server side of the agent contract (docs/AGENT.md, "Agent API"):
 * enrollment, configuration, heartbeat with tasks, runs and their results,
 * and the self-update offer. Every function works for one authenticated
 * endpoint (`AgentContext`) inside a transaction pinned to its tenant.
 */

export const ENROLLMENT_INVALID_PROBLEM = "urn:restow:problem:enrollment-token-invalid";
export const UNSUPPORTED_OS_PROBLEM = ENDPOINT_PROBLEMS.unsupportedOs;

/** Failed enrollments per address: a guess costs the attacker one of 20 attempts in 10 minutes. */
export const enrollFailures = new FailureTracker(20);

/** A delivered task nobody started a run for is handed out again after this long. */
const REDELIVER_AFTER_MS = 30 * 60 * 1000;
const MAX_TASKS_PER_HEARTBEAT = 10;
const LOG_TAIL_KEEP = 20 * 1024;

export interface AgentTask {
  id: string;
  kind: "backup_now" | "restore" | "verify_sample" | "update_config" | "uninstall";
  params: Record<string, unknown>;
}

export interface EnrollResponse {
  endpointId: string;
  agentSecret: string;
  repository: { url: string; password: string };
  config: AgentConfigResponse;
  restic: { version: string };
}

/**
 * What `GET /agent/v1/config` answers: the stored configuration, without the bandwidth windows
 * (the agent does not know them) and with `bandwidthKbps` as the limit that applies at `now`, the
 * active window's, else the default. The stored configuration and its version are never touched
 * by a window starting or ending, so the agent's cached copy never goes stale because of one; it
 * asks again when a backup starts and then gets the limit of that moment. A machine in no backup
 * job (schedule `none`) is sent no folders and no hooks (`agentFacingConfig`): an agent older
 * than 0.2.1 does not know `none` and would otherwise back them up on its profile's default.
 */
export function configResponse(
  config: EndpointConfig,
  configVersion: number,
  effective?: { zone: string; now: Date },
): AgentConfigResponse {
  const { bandwidthWindows, ...rest } = agentFacingConfig(config);
  if (!bandwidthWindows || bandwidthWindows.length === 0 || !effective) {
    return { ...rest, configVersion };
  }
  return {
    ...rest,
    bandwidthKbps: effectiveBandwidthKbps(
      config.bandwidthKbps,
      bandwidthWindows,
      effective.zone,
      effective.now,
    ),
    configVersion,
  };
}

/**
 * The zone a machine's bandwidth windows are read in: the zone of its schedule; where that is
 * missing (a configuration of an older release, a schedule that never named one), the tenant's
 * zone, else the installation's default.
 */
async function bandwidthZoneOf(
  tx: Transaction,
  tenantId: string,
  config: EndpointConfig,
): Promise<string> {
  const own = config.schedule?.timeZone;
  if (typeof own === "string" && own !== "" && isValidTimeZone(own)) {
    return own;
  }
  const [tenant] = await tx
    .select({ timeZone: tenants.timeZone })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return bandwidthTimeZone(tenant?.timeZone);
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

/** The repository URL an agent is given: the restic REST backend of this instance. */
export function repositoryUrl(instanceUrl: string, endpointId: string): string {
  return `rest:${instanceUrl.replace(/\/+$/, "")}/agent/restic/${endpointId}/`;
}

async function releaseToken(tokenId: string): Promise<void> {
  await providerDb
    .update(endpointEnrollmentTokens)
    .set({ usedAt: null, usedByEndpointId: null })
    .where(eq(endpointEnrollmentTokens.id, tokenId));
}

/**
 * Enroll a machine with a one-time token. The token is claimed atomically
 * (single use); a failure after that point undoes everything so the same
 * install command can be run again. The server creates the restic repository
 * itself with a fresh random password, so the agent never needs to write a
 * config or delete anything.
 */
export async function enrollEndpoint(
  input: EnrollInput,
  context: { ip: string | null; instanceUrl: string },
  now: Date = new Date(),
): Promise<EnrollResponse> {
  if (!isSupportedEndpointOs(input.os)) {
    throw new ProblemError(422, "Operating system not supported", {
      type: UNSUPPORTED_OS_PROBLEM,
      detail:
        input.os === "windows"
          ? "Windows endpoints are not supported yet. This release backs up Linux and macOS machines."
          : `The operating system "${input.os.slice(0, 40)}" is not supported. This release backs up Linux and macOS machines.`,
      extensions: { supported: ["linux", "darwin"] },
    });
  }
  const os = input.os;
  const tokenHash = hashSecret(input.token);
  const [claimed] = await providerDb
    .update(endpointEnrollmentTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(endpointEnrollmentTokens.tokenHash, tokenHash),
        isNull(endpointEnrollmentTokens.usedAt),
        isNull(endpointEnrollmentTokens.revokedAt),
        gt(endpointEnrollmentTokens.expiresAt, now),
      ),
    )
    .returning();
  if (!claimed) {
    const [known] = await providerDb
      .select()
      .from(endpointEnrollmentTokens)
      .where(eq(endpointEnrollmentTokens.tokenHash, tokenHash))
      .limit(1);
    throw new ProblemError(401, "Enrollment token not valid", {
      type: ENROLLMENT_INVALID_PROBLEM,
      detail: "The enrollment token is unknown, expired, revoked or already used.",
      extensions: { reason: known ? enrollmentTokenState(known, now) : "unknown" },
    });
  }

  const tenantId = claimed.tenantId;
  const endpointId = randomUUID();
  const secret = generateAgentSecret();
  const repositoryPassword = randomBytes(32).toString("base64url");
  let secretId: string | null = null;
  let endpointCreated = false;
  try {
    const [tenant] = await providerDb
      .select({ status: tenants.status, timeZone: tenants.timeZone })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant || tenant.status !== "active") {
      throw new ProblemError(403, "Tenant suspended", {
        detail: "The tenant of this enrollment token is currently suspended.",
      });
    }
    // No schedule until an admin puts the machine into a backup job (docs/AGENT.md, "Jobs"); the
    // profile's folders stay in the configuration for the job editor to start from.
    const config = enrolledEndpointConfig(os, claimed.profile, {
      timeZone: tenant.timeZone ?? DEFAULT_SCHEDULE_TIMEZONE,
    });
    const stored = await storeSecret(db, {
      tenantId,
      kind: REPOSITORY_SECRET_KIND,
      plaintext: repositoryPassword,
    });
    secretId = stored.id;
    await withTenantTx(db, tenantId, async (tx) => {
      await tx.insert(endpoints).values({
        id: endpointId,
        tenantId,
        hostname: input.hostname,
        displayName: claimed.displayName,
        os,
        arch: input.arch,
        profile: claimed.profile,
        agentVersion: input.agentVersion,
        osVersion: input.osVersion,
        secretHash: secret.hash,
        repositorySecretId: stored.id,
        config,
        configVersion: 1,
        settings: {
          ...(input.hooks ? { agent: { hooks: input.hooks, reportedAt: now.toISOString() } } : {}),
        },
        lastSeenAt: now,
      });
    });
    endpointCreated = true;
    await providerDb
      .update(endpointEnrollmentTokens)
      .set({ usedByEndpointId: endpointId })
      .where(eq(endpointEnrollmentTokens.id, claimed.id));

    // The server creates the repository: the agent is append-only and cannot.
    const access = await repositoryAccess(
      db,
      { id: endpointId, tenantId, repositorySecretId: stored.id },
      { forWrite: true },
    );
    await withRepository(access, (session) => resticInit(session));
    // The password also lies next to the repository, sealed with the tenant key, so the
    // master key and the storage are enough to restore without this database.
    const dek = await withTenantTx(db, tenantId, (tx) => loadTenantDek(tx, tenantId));
    await access.storage.put(
      endpointPasswordKey(endpointId),
      sealEndpointPassword({ tenantId, endpointId, password: repositoryPassword, dek }),
    );

    await auditEndpoint(db, {
      tenantId,
      actor: agentActor(input.hostname, context.ip),
      action: ENDPOINT_AUDIT_ACTIONS.enrolled,
      endpointId,
      details: {
        hostname: input.hostname,
        os,
        arch: input.arch,
        profile: claimed.profile,
        agentVersion: input.agentVersion,
        osVersion: input.osVersion,
        tokenId: claimed.id,
        hooks: input.hooks ?? null,
      },
    });
    return {
      endpointId,
      agentSecret: secret.value,
      repository: {
        url: repositoryUrl(context.instanceUrl, endpointId),
        password: repositoryPassword,
      },
      config: configResponse(config, 1),
      restic: { version: RESTIC_VERSION },
    };
  } catch (error) {
    // Nothing was handed out: undo, so the token works for a retry.
    try {
      if (endpointCreated) {
        await withTenantTx(db, tenantId, (tx) =>
          tx.delete(endpoints).where(eq(endpoints.id, endpointId)),
        );
      }
      if (secretId) {
        await removeSecret(tenantId, secretId);
      }
      const targets = await tenantStorage(db, tenantId).catch(() => null);
      if (targets) {
        await removeRepositoryObjects(targets.storage, `endpoints/${endpointId}/`);
      }
      await releaseToken(claimed.id);
    } catch {
      // The original failure is the one to report.
    }
    forgetTenantStorage(tenantId);
    // A missing restic binary or an unreadable repository is the server's problem, told as such.
    throw resticProblem(error);
  }
}

// ---------------------------------------------------------------------------
// Configuration and heartbeat
// ---------------------------------------------------------------------------

async function loadEndpoint(tx: Transaction, agent: AgentContext): Promise<Endpoint> {
  const [endpoint] = await tx
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.id, agent.endpointId), eq(endpoints.tenantId, agent.tenantId)))
    .limit(1);
  if (!endpoint) {
    throw new ProblemError(404, "Endpoint not found");
  }
  return endpoint;
}

export async function agentConfig(
  agent: AgentContext,
  now: Date = new Date(),
): Promise<AgentConfigResponse> {
  return withTenantTx(db, agent.tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, agent);
    const windows = endpoint.config.bandwidthWindows;
    const zone =
      windows && windows.length > 0
        ? await bandwidthZoneOf(tx, agent.tenantId, endpoint.config)
        : null;
    return configResponse(
      endpoint.config,
      endpoint.configVersion,
      zone === null ? undefined : { zone, now },
    );
  });
}

function toAgentTask(row: {
  id: string;
  kind: AgentTask["kind"];
  params: Record<string, unknown>;
}): AgentTask {
  return { id: row.id, kind: row.kind, params: row.params };
}

/**
 * What an agent reports about the machine, merged into `settings.agent`; null
 * for an agent that reports nothing (an earlier pre-release agent).
 */
export function agentFactsOf(input: Pick<HeartbeatInput, "hooks" | "hookScripts">, now: Date) {
  if (!input.hooks) {
    return null;
  }
  return {
    hooks: input.hooks,
    ...(input.hooks === "scripts" ? { hookScripts: input.hookScripts ?? [] } : {}),
    reportedAt: now.toISOString(),
  };
}

/** Record a heartbeat and hand out what is waiting for the agent. */
export async function heartbeat(
  agent: AgentContext,
  input: HeartbeatInput,
  now: Date = new Date(),
): Promise<{ tasks: AgentTask[] }> {
  return withTenantTx(db, agent.tenantId, async (tx) => {
    const nextRunAt = input.nextRunAt ? new Date(input.nextRunAt) : null;
    const facts = agentFactsOf(input, now);
    const [endpoint] = await tx
      .update(endpoints)
      .set({
        agentVersion: input.agentVersion,
        osVersion: input.osVersion,
        agentState: input.state,
        nextRunAt: nextRunAt && !Number.isNaN(nextRunAt.getTime()) ? nextRunAt : null,
        agentConfigVersion: input.configVersion ?? null,
        lastSeenAt: now,
        ...(agent.profile === "server" ? { staleAlertedAt: null } : {}),
        // Only the agent's own facts change; the settings an admin made stay as they are.
        ...(facts
          ? {
              settings: sql`jsonb_set(${endpoints.settings}, '{agent}', ${JSON.stringify(facts)}::jsonb)`,
            }
          : {}),
      })
      .where(and(eq(endpoints.id, agent.endpointId), eq(endpoints.tenantId, agent.tenantId)))
      .returning();
    if (!endpoint) {
      throw new ProblemError(404, "Endpoint not found");
    }

    // Tasks nobody picked up in time end here.
    await tx
      .update(endpointTasks)
      .set({ status: "failed", finishedAt: now, errorMessage: "expired" })
      .where(
        and(
          eq(endpointTasks.endpointId, agent.endpointId),
          eq(endpointTasks.status, "pending"),
          lt(endpointTasks.expiresAt, now),
        ),
      );

    const redeliverBefore = new Date(now.getTime() - REDELIVER_AFTER_MS);
    const waiting = await tx
      .select()
      .from(endpointTasks)
      .where(
        and(
          eq(endpointTasks.endpointId, agent.endpointId),
          or(
            and(
              eq(endpointTasks.status, "pending"),
              // A restore test offered again waits for its time (ISO-8601 in UTC, compared as text).
              sql`coalesce(${endpointTasks.params} ->> 'notBefore', '') COLLATE "C" <= ${now.toISOString()}::text`,
            ),
            and(
              eq(endpointTasks.status, "delivered"),
              lt(endpointTasks.deliveredAt, redeliverBefore),
              sql`NOT EXISTS (SELECT 1 FROM ${endpointRuns} r WHERE r.task_id = ${endpointTasks.id})`,
            ),
          ),
        ),
      )
      .orderBy(asc(endpointTasks.createdAt))
      .limit(MAX_TASKS_PER_HEARTBEAT);

    const tasks: AgentTask[] = [];
    const finishedOnDelivery = waiting
      .filter((task) => task.kind === "update_config" || task.kind === "uninstall")
      .map((task) => task.id);
    for (const task of waiting) {
      tasks.push(toAgentTask({ id: task.id, kind: task.kind, params: task.params }));
    }
    if (waiting.length > 0) {
      await tx
        .update(endpointTasks)
        .set({ status: "delivered", deliveredAt: now })
        .where(
          inArray(
            endpointTasks.id,
            waiting.map((task) => task.id),
          ),
        );
    }
    if (finishedOnDelivery.length > 0) {
      await tx
        .update(endpointTasks)
        .set({ status: "done", finishedAt: now })
        .where(inArray(endpointTasks.id, finishedOnDelivery));
    }

    // An agent that runs another configuration than the server holds is told to fetch it.
    const drifted =
      input.configVersion !== null &&
      input.configVersion !== undefined &&
      input.configVersion !== endpoint.configVersion;
    if (drifted && !waiting.some((task) => task.kind === "update_config")) {
      const [created] = await tx
        .insert(endpointTasks)
        .values({
          tenantId: agent.tenantId,
          endpointId: agent.endpointId,
          kind: "update_config",
          params: { configVersion: endpoint.configVersion },
          status: "done",
          deliveredAt: now,
          finishedAt: now,
        })
        .returning();
      if (created) {
        tasks.push(toAgentTask({ id: created.id, kind: "update_config", params: created.params }));
      }
    }

    // A delivered uninstall ends the endpoint: it cannot back up any more.
    if (waiting.some((task) => task.kind === "uninstall")) {
      await tx
        .update(endpoints)
        .set({ status: "revoked", revokedAt: now })
        .where(eq(endpoints.id, agent.endpointId));
      await auditEndpoint(tx, {
        tenantId: agent.tenantId,
        actor: agentActor(agent.hostname, agent.ip),
        action: ENDPOINT_AUDIT_ACTIONS.revoked,
        endpointId: agent.endpointId,
        details: { reason: "uninstalled" },
      });
    }
    return { tasks };
  });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const TASK_KIND_OF_RUN = {
  backup: "backup_now",
  restore: "restore",
  verify_sample: "verify_sample",
} as const;

/** Clamp a time the agent reports: never in the future, never more than a day back. */
function agentTime(value: string, now: Date): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() > now.getTime()) {
    return now;
  }
  const earliest = now.getTime() - 24 * 60 * 60 * 1000;
  return parsed.getTime() < earliest ? new Date(earliest) : parsed;
}

export async function startRun(
  agent: AgentContext,
  input: StartRunInput,
  now: Date = new Date(),
): Promise<{ runId: string }> {
  return withTenantTx(db, agent.tenantId, async (tx) => {
    if (input.taskId) {
      const [task] = await tx
        .select()
        .from(endpointTasks)
        .where(
          and(eq(endpointTasks.id, input.taskId), eq(endpointTasks.endpointId, agent.endpointId)),
        )
        .limit(1);
      if (!task) {
        throw new ProblemError(404, "Task not found");
      }
      if (task.kind !== TASK_KIND_OF_RUN[input.kind]) {
        throw new ProblemError(409, "Task does not match the run", {
          detail: `A ${task.kind} task cannot start a ${input.kind} run.`,
        });
      }
      if (task.status !== "pending" && task.status !== "delivered") {
        throw new ProblemError(409, "Task already finished");
      }
      if (task.status === "pending") {
        await tx
          .update(endpointTasks)
          .set({ status: "delivered", deliveredAt: now })
          .where(eq(endpointTasks.id, task.id));
      }
    }
    const [run] = await tx
      .insert(endpointRuns)
      .values({
        tenantId: agent.tenantId,
        endpointId: agent.endpointId,
        kind: input.kind,
        status: "running",
        startedAt: agentTime(input.startedAt, now),
        taskId: input.taskId ?? null,
      })
      .returning({ id: endpointRuns.id });
    if (!run) {
      throw new Error("run insert returned no row");
    }
    // The first point of the run's throughput history, with the size of the repository to measure upload by.
    await startRunSamples(tx, agent, run.id, now);
    return { runId: run.id };
  });
}

export async function reportProgress(
  agent: AgentContext,
  runId: string,
  input: ProgressInput,
  now: Date = new Date(),
): Promise<void> {
  await withTenantTx(db, agent.tenantId, async (tx) => {
    const updated = await tx
      .update(endpointRuns)
      .set({
        progress: {
          filesDone: input.filesDone,
          bytesDone: input.bytesDone,
          ...(input.totalFiles !== undefined ? { totalFiles: input.totalFiles } : {}),
          ...(input.totalBytes !== undefined ? { totalBytes: input.totalBytes } : {}),
          ...(input.currentPath !== undefined ? { currentPath: input.currentPath } : {}),
          updatedAt: now.toISOString(),
        },
      })
      .where(
        and(
          eq(endpointRuns.id, runId),
          eq(endpointRuns.endpointId, agent.endpointId),
          eq(endpointRuns.status, "running"),
        ),
      )
      .returning({ id: endpointRuns.id });
    if (updated.length === 0) {
      throw new ProblemError(404, "Run not found or already finished");
    }
    await recordProgressSample(tx, agent, runId, input.bytesDone, now);
  });
}

/** The tail of a log, cut on a line boundary where it can be. */
export function trimLogTail(log: string, keep = LOG_TAIL_KEEP): string {
  const bytes = Buffer.byteLength(log, "utf8");
  if (bytes <= keep) {
    return log;
  }
  const tail = Buffer.from(log, "utf8")
    .subarray(bytes - keep)
    .toString("utf8");
  const newline = tail.indexOf("\n");
  return newline >= 0 && newline < 512 ? tail.slice(newline + 1) : tail;
}

/** The errors to store: bounded, and their messages redacted (the agent's own redaction is not relied on). */
function boundedErrors(
  errors: FinishRunInput["errors"],
): { path?: string; message: string; code?: string }[] {
  return errors.slice(0, MAX_ERRORS).map((error) => ({
    ...(error.path ? { path: error.path.slice(0, 1024) } : {}),
    message: redactAgentMessage(error.message, 1000),
    ...(error.code ? { code: error.code.slice(0, 100) } : {}),
  }));
}

/** The stored explanation of a run that did not end well; null for a good one. */
export function failureRecordOf(
  status: FinishRunInput["status"],
  errors: readonly { path?: string; message: string; code?: string }[],
  now: Date,
) {
  if (status === "succeeded") {
    return null;
  }
  const cause = failureOfRun(errors);
  return cause ? toFailureRecord(cause, { now }) : null;
}

export interface FinishedRun {
  runId: string;
  status: EndpointRun["status"];
}

/**
 * Close a run with the agent's result and pass it on: the endpoint's last
 * backup, the samples for the restore test, the task, the report of an
 * agent-side restore test, and a `job.failed` webhook for a failed run.
 * Repeating the call for a finished run answers the same and changes nothing.
 */
export async function finishRun(
  agent: AgentContext,
  runId: string,
  input: FinishRunInput,
  now: Date = new Date(),
): Promise<FinishedRun> {
  return withTenantTx(db, agent.tenantId, async (tx) => {
    const [run] = await tx
      .select()
      .from(endpointRuns)
      .where(and(eq(endpointRuns.id, runId), eq(endpointRuns.endpointId, agent.endpointId)))
      .for("update")
      .limit(1);
    if (!run) {
      throw new ProblemError(404, "Run not found");
    }
    if (run.status !== "running") {
      return { runId, status: run.status };
    }
    const finishedAt = agentTime(input.finishedAt, now);
    const errors = boundedErrors(input.errors);
    const failure = failureRecordOf(input.status, errors, now);
    await tx
      .update(endpointRuns)
      .set({
        status: input.status,
        finishedAt: finishedAt.getTime() < run.startedAt.getTime() ? now : finishedAt,
        snapshotId: input.snapshotId ?? null,
        stats: input.stats ?? null,
        errors,
        // What went wrong, explained: the headline, the reason and what to do, in the viewer's language.
        failure,
        // Redacted before it is cut, so a credential is never kept in part.
        logTail: trimLogTail(redactAgentLog(input.logTail.slice(-MAX_LOG_TAIL_BYTES))),
        progress: null,
      })
      .where(eq(endpointRuns.id, runId));
    // The last point of the throughput history: the final counters, so the charts end where the run did.
    await recordProgressSample(
      tx,
      agent,
      runId,
      Math.max(input.stats?.totalBytesProcessed ?? 0, run.progress?.bytesDone ?? 0),
      now,
    );

    const [endpoint] = await tx
      .select()
      .from(endpoints)
      .where(eq(endpoints.id, agent.endpointId))
      .limit(1);
    if (!endpoint) {
      throw new ProblemError(404, "Endpoint not found");
    }

    // An agent that was restarted mid-run picks the work up again: that is not an outcome.
    const interrupted = input.status === "failed" && isInterruptedOnly(errors);

    if (run.kind === "backup") {
      const good = input.status !== "failed" && input.snapshotId !== undefined;
      const change = {
        ...(interrupted ? {} : { lastBackupAt: finishedAt }),
        ...(good
          ? { lastSuccessAt: finishedAt, lastSnapshotId: input.snapshotId, staleAlertedAt: null }
          : {}),
      };
      // An interrupted run changes nothing about the endpoint (an empty update would be an error).
      if (Object.keys(change).length > 0) {
        await tx.update(endpoints).set(change).where(eq(endpoints.id, agent.endpointId));
      }
      if (good && input.sample && input.sample.length > 0) {
        const unique = new Map(input.sample.map((sample) => [sample.path, sample]));
        await tx
          .insert(endpointSamples)
          .values(
            [...unique.values()].map((sample) => ({
              tenantId: agent.tenantId,
              endpointId: agent.endpointId,
              runId,
              snapshotId: input.snapshotId as string,
              path: sample.path,
              sha256: sample.sha256.toLowerCase(),
              size: sample.size,
            })),
          )
          .onConflictDoNothing();
      }
      // Samples of long-gone backups are of no use for a restore test.
      await tx
        .delete(endpointSamples)
        .where(
          and(
            eq(endpointSamples.endpointId, agent.endpointId),
            lt(endpointSamples.createdAt, new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)),
          ),
        );
    }

    if (run.kind === "restore") {
      await auditEndpoint(tx, {
        tenantId: agent.tenantId,
        actor: agentActor(agent.hostname, agent.ip),
        action: ENDPOINT_AUDIT_ACTIONS.restoreFinished,
        endpointId: agent.endpointId,
        details: { runId, status: input.status, taskId: run.taskId, errors: errors.length },
      });
    }

    // A restore test that could not complete is no outcome either: no rating, no webhook.
    const incompleteTest =
      run.kind === "verify_sample" &&
      (await recordAgentRestoreTest(tx, agent, run, input, errors, endpoint, now)) === "incomplete";

    if (run.taskId) {
      await tx
        .update(endpointTasks)
        .set({
          status: input.status === "failed" ? "failed" : "done",
          finishedAt: now,
          errorMessage:
            input.status === "failed" ? (errors[0]?.message ?? "failed").slice(0, 500) : null,
        })
        .where(eq(endpointTasks.id, run.taskId));
    }

    if (input.status === "failed" && !interrupted && !incompleteTest) {
      await emitWebhookEvent(tx, {
        tenantId: agent.tenantId,
        event: "job.failed",
        occurredAt: now,
        data: {
          job: {
            id: runId,
            queue: `endpoint_${run.kind}`,
            status: "failed",
            protectedObjectId: null,
            startedAt: run.startedAt.toISOString(),
            completedAt: finishedAt.toISOString(),
            durationMs: Math.max(0, finishedAt.getTime() - run.startedAt.getTime()),
            errorMessage: errors[0]?.message ?? null,
            // Why it failed, machine-readable: a stable code, whether waiting alone may help, parameters.
            failure,
          },
          endpoint: {
            id: endpoint.id,
            hostname: endpoint.hostname,
            displayName: endpoint.displayName,
            profile: endpoint.profile,
            os: endpoint.os,
          },
        },
      });
    }
    return { runId, status: input.status };
  });
}

type VerifySampleTaskParams = RestoreTestTaskParams;

/**
 * The agent's own restore test becomes a report, like the server's, so both
 * rate the snapshot: green or red, judged by the same rules as the server's
 * test (@restow/core `judgeAgentRestoreTest`). A test that could not complete
 * rates nothing: no report, `last_restore_test_at` stays, and the test is
 * offered again later.
 */
async function recordAgentRestoreTest(
  tx: Transaction,
  agent: AgentContext,
  run: EndpointRun,
  input: FinishRunInput,
  errors: { path?: string; message: string; code?: string }[],
  endpoint: Endpoint,
  now: Date,
): Promise<"rated" | "incomplete"> {
  let task: { id: string; params: VerifySampleTaskParams } | undefined;
  if (run.taskId) {
    const [row] = await tx
      .select({ id: endpointTasks.id, params: endpointTasks.params })
      .from(endpointTasks)
      .where(eq(endpointTasks.id, run.taskId))
      .limit(1);
    task = row ? { id: row.id, params: row.params as VerifySampleTaskParams } : undefined;
  }
  const params = task?.params ?? {};
  const snapshotId = params.snapshotId ?? input.snapshotId ?? null;
  const files = Array.isArray(params.files) ? params.files : [];
  const verdict = judgeAgentRestoreTest({
    expected: files,
    status: input.status,
    errorCount: errors.length,
    report: input.restoreTest,
    // Retention may have forgotten a snapshot that is no longer the newest since the test was asked for.
    snapshotMayBeGone: snapshotId !== endpoint.lastSnapshotId,
  });
  if (verdict.rating === "incomplete") {
    if (task && snapshotId !== null && files.length > 0) {
      await offerRestoreTestAgain(
        tx,
        agent,
        endpoint,
        task.id,
        { ...params, snapshotId, files },
        now,
      );
    }
    return "incomplete";
  }
  const { result } = verdict;
  await tx.insert(endpointReports).values({
    tenantId: agent.tenantId,
    endpointId: agent.endpointId,
    kind: "restore_test",
    origin: "agent",
    snapshotId,
    readiness: verdict.rating,
    summary: {
      files: result.files,
      matched: result.matched,
      mismatched: result.mismatched.slice(0, 20).map((file) => ({
        path: file.path,
        expected: file.expected,
        actual: file.actual,
        ...(file.reason ? { reason: file.reason.slice(0, 300) } : {}),
      })),
    },
    runId: run.id,
    checkedAt: now,
  });
  await tx
    .update(endpoints)
    .set({ lastRestoreTestAt: now })
    .where(eq(endpoints.id, agent.endpointId));
  return "rated";
}

/**
 * Offer a restore test that could not complete again, as a new task (the
 * agent runs a task id only once), after the next wait of @restow/core
 * `RESTORE_TEST_RETRY_DELAYS_MS`. Only for the endpoint's newest backup (a
 * rating of an older one does not count), only while waits are left, and only
 * once: not when a test of this backup already waits (@restow/core
 * `restoreTestRetry`; the worker's monitor applies the same rules to a test
 * whose agent went silent).
 */
async function offerRestoreTestAgain(
  tx: Transaction,
  agent: AgentContext,
  endpoint: Endpoint,
  taskId: string,
  params: VerifySampleTaskParams & { snapshotId: string },
  now: Date,
): Promise<void> {
  const next = restoreTestRetry(params, endpoint, now);
  if (!next) {
    return;
  }
  const waiting = await tx
    .select({ id: endpointTasks.id, params: endpointTasks.params })
    .from(endpointTasks)
    .where(
      and(
        eq(endpointTasks.endpointId, agent.endpointId),
        eq(endpointTasks.kind, "verify_sample"),
        inArray(endpointTasks.status, ["pending", "delivered"]),
      ),
    );
  if (restoreTestAlreadyWaiting(waiting, params.snapshotId, taskId)) {
    return;
  }
  await tx.insert(endpointTasks).values({
    tenantId: agent.tenantId,
    endpointId: agent.endpointId,
    kind: "verify_sample",
    params: next.params,
    createdAt: now,
    expiresAt: next.expiresAt,
  });
}

// ---------------------------------------------------------------------------
// Self-update
// ---------------------------------------------------------------------------

/**
 * A newer signed agent release on this instance, for the agent to fetch and
 * verify against the maintainer's signature, or null (also while the tenant
 * has paused agent updates).
 */
export async function agentUpdate(
  agent: AgentContext,
  instanceUrl: string,
): Promise<{ version: string; url: string; sha256: string } | null> {
  const { endpoint, tenantPaused } = await withTenantTx(db, agent.tenantId, async (tx) => {
    const loaded = await loadEndpoint(tx, agent);
    const [tenant] = await tx
      .select({ paused: tenants.agentUpdatesPaused })
      .from(tenants)
      .where(eq(tenants.id, agent.tenantId))
      .limit(1);
    return { endpoint: loaded, tenantPaused: tenant?.paused === true };
  });
  // The tenant's setting covers every machine, also the ones that enrol later; a machine can
  // still be paused on its own.
  if (tenantPaused || endpoint.settings.autoUpdatePaused === true) {
    return null;
  }
  const release = await latestAgentRelease(endpoint.os, endpoint.arch);
  if (!release) {
    return null;
  }
  const current = endpoint.agentVersion ?? "";
  if (isAgentVersion(current) && compareAgentVersions(release.version, current) <= 0) {
    return null;
  }
  return {
    version: release.version,
    url: `${instanceUrl.replace(/\/+$/, "")}/install/agent/${release.version}/${release.target}/${release.file}`,
    sha256: release.sha256,
  };
}
