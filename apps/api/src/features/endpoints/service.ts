import type { Readable } from "node:stream";
import {
  type DirectoryPosition,
  ENDPOINT_QUEUES,
  type EndpointJobPayload,
  type OpenRepository,
  type ResticError,
  ResticError as ResticErrorClass,
  SelectionError,
  type SnapshotFlagReason,
  endpointQuotaLimits,
  endpointSingletonKey,
  enrollmentTokenExpiry,
  enrollmentTokenState,
  generateEnrollmentToken,
  isSupportedEndpointOs,
  isUnscheduled,
  noSchedule,
  normalizeBandwidthWindows,
  openRepository,
  resolveSelection,
  resticListDirectory,
  resticSnapshots,
  streamSnapshotZip,
} from "@restow/core";
import {
  type Database,
  type Endpoint,
  type EndpointConfig,
  type EndpointRun,
  type EndpointSettings,
  type EndpointTask,
  endpointDownloads,
  endpointEnrollmentTokens,
  endpointReports,
  endpointRuns,
  endpointSnapshotFlags,
  endpointTasks,
  endpoints,
  tenants,
  users,
} from "@restow/db";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { decodeCursor, encodeCursor } from "../../routes/v1/cursor.js";
import { sameJson } from "../backup-jobs/json.js";
import { jobRetentionOf, jobWithOverridesOf, jobsOfEndpoints } from "../backup-jobs/membership.js";
import { pgBossExecutor } from "../jobs/pg-boss-tx.js";
import { isMissingQueueSchema, jobQueue } from "../jobs/queue.js";
import { ENDPOINT_AUDIT_ACTIONS, type EndpointActor, auditEndpoint } from "./audit.js";
import { bandwidthWindowsProblem } from "./bandwidth.js";
import { installCommands } from "./commands.js";
import { isSafeOrigin } from "./distribution.js";
import {
  type BrowseDto,
  type CreatedTokenDto,
  type EndpointAssigneeDto,
  type EndpointDetailDto,
  type EndpointSummaryDto,
  type EnrollmentTokenDto,
  NO_RATED_TESTS,
  type PreparedDownloadDto,
  type RatedTests,
  type ReportDto,
  type RunDetailDto,
  type RunSummaryDto,
  type SnapshotDto,
  type TaskDto,
  effectiveSettings,
  hookFingerprint,
  hooksOf,
  problemsOf,
  storageOf,
  toReport,
  toRunDetail,
  toRunSummary,
  toSummary,
  toTask,
} from "./dto.js";
import { isInsecureTransport } from "./instance-url.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import { loadEndpointReadiness } from "./readiness.js";
import { holdRepositoryForRead, repositoryAccess } from "./repository.js";
import { resticGate } from "./restic-gate.js";
import { resticProblem } from "./restic-problem.js";
import {
  type CreateDownloadInput,
  type CreateTaskInput,
  HOOK_SCRIPT_NAME,
  type UpdateEndpointInput,
} from "./schemas.js";

/**
 * The session API of the endpoint feature (docs/AGENT.md): what tenant admins
 * do in the web app. Every change and every read of backed-up files (browse,
 * download) is audited. The agent secret and the repository password never
 * appear in a response.
 */

export type { EndpointActor };

export const AGENT_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Finished requests the detail page lists besides the ones still waiting. */
export const RECENT_TASKS = 20;

/** Enrollment tokens one listing returns. */
const TOKEN_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const UNSUPPORTED_OS_PROBLEM = ENDPOINT_PROBLEMS.unsupportedOs;

export { resticProblem };

function notFound(): ProblemError {
  return new ProblemError(404, "Endpoint not found");
}

async function loadEndpoint(tx: Transaction, tenantId: string, id: string): Promise<Endpoint> {
  const [endpoint] = await tx
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.id, id)))
    .limit(1);
  if (!endpoint) {
    throw notFound();
  }
  return endpoint;
}

// ---------------------------------------------------------------------------
// Lists and detail
// ---------------------------------------------------------------------------

async function latestRuns(
  tx: Transaction,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, EndpointRun>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await tx
    .selectDistinctOn([endpointRuns.endpointId])
    .from(endpointRuns)
    .where(and(eq(endpointRuns.tenantId, tenantId), inArray(endpointRuns.endpointId, [...ids])))
    .orderBy(endpointRuns.endpointId, desc(endpointRuns.startedAt));
  return new Map(rows.map((row) => [row.endpointId, row]));
}

/**
 * Which of `runs` and `tasks` are restore tests on the machine that a report
 * rated (`RatedTests` in dto.ts): the finished `verify_sample` runs and the
 * failed `verify_sample` tasks among them, looked up by the report's `run_id`.
 * At most two small queries, none when the lists hold no such run or task.
 */
export async function loadRatedTests(
  tx: Transaction,
  tenantId: string,
  runs: readonly Pick<EndpointRun, "id" | "kind" | "status">[],
  tasks: readonly Pick<EndpointTask, "id" | "kind" | "status">[] = [],
): Promise<RatedTests> {
  const runIds = runs
    .filter((run) => run.kind === "verify_sample" && run.status !== "running")
    .map((run) => run.id);
  const taskIds = tasks
    .filter((task) => task.kind === "verify_sample" && task.status === "failed")
    .map((task) => task.id);
  const taskOfRun = new Map<string, string>();
  if (taskIds.length > 0) {
    const carried = await tx
      .select({ id: endpointRuns.id, taskId: endpointRuns.taskId })
      .from(endpointRuns)
      .where(and(eq(endpointRuns.tenantId, tenantId), inArray(endpointRuns.taskId, taskIds)));
    for (const run of carried) {
      if (run.taskId) {
        taskOfRun.set(run.id, run.taskId);
      }
    }
  }
  const candidates = [...new Set([...runIds, ...taskOfRun.keys()])];
  if (candidates.length === 0) {
    return NO_RATED_TESTS;
  }
  const reported = await tx
    .selectDistinct({ runId: endpointReports.runId })
    .from(endpointReports)
    .where(
      and(
        eq(endpointReports.tenantId, tenantId),
        eq(endpointReports.kind, "restore_test"),
        inArray(endpointReports.runId, candidates),
      ),
    );
  const ratedRuns = new Set(
    reported.map((row) => row.runId).filter((id): id is string => id !== null),
  );
  const ratedTasks = new Set(
    [...taskOfRun].filter(([runId]) => ratedRuns.has(runId)).map(([, taskId]) => taskId),
  );
  return { runs: ratedRuns, tasks: ratedTasks };
}

/**
 * The people of the tenant's protection directory the given ids name, by id (the persons machines
 * are assigned to). An id that is not in the directory is missing from the map.
 */
export async function loadAssignees(
  tx: Transaction,
  tenantId: string,
  ids: readonly (string | null)[],
): Promise<Map<string, EndpointAssigneeDto>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), inArray(users.id, wanted)));
  return new Map(rows.map((row) => [row.id, row]));
}

function assigneeOf(
  map: ReadonlyMap<string, EndpointAssigneeDto>,
  endpoint: Pick<Endpoint, "assignedUserId">,
): EndpointAssigneeDto | null {
  return endpoint.assignedUserId ? (map.get(endpoint.assignedUserId) ?? null) : null;
}

export async function listEndpoints(
  database: Database,
  tenantId: string,
  filter: { profile?: Endpoint["profile"] } = {},
  now: Date = new Date(),
): Promise<{ items: EndpointSummaryDto[] }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(endpoints)
      .where(
        and(
          eq(endpoints.tenantId, tenantId),
          filter.profile ? eq(endpoints.profile, filter.profile) : undefined,
        ),
      )
      .orderBy(endpoints.hostname);
    const ids = rows.map((row) => row.id);
    const runs = await latestRuns(tx, tenantId, ids);
    const readiness = await loadEndpointReadiness(tx, tenantId, ids, now);
    const rated = await loadRatedTests(tx, tenantId, [...runs.values()]);
    const jobsOf = await jobsOfEndpoints(tx, tenantId, ids);
    const assignees = await loadAssignees(
      tx,
      tenantId,
      rows.map((row) => row.assignedUserId),
    );
    return {
      items: rows.map((row) =>
        toSummary(
          row,
          runs.get(row.id) ?? null,
          readinessOf(readiness, row.id),
          now,
          rated,
          jobsOf.get(row.id) ?? null,
          assigneeOf(assignees, row),
        ),
      ),
    };
  });
}

function readinessOf(
  map: Awaited<ReturnType<typeof loadEndpointReadiness>>,
  id: string,
): Awaited<ReturnType<typeof loadEndpointReadiness>> extends Map<string, infer V> ? V : never {
  const found = map.get(id);
  if (!found) {
    throw new Error("readiness missing");
  }
  return found;
}

export interface DetailOptions {
  /**
   * Whether the viewer may see the hook texts: only who may change the
   * configuration (a hook may hold credentials). Everyone else learns whether
   * a hook is set and its fingerprint.
   */
  revealHooks: boolean;
}

/** The commands of a system, or null when the address cannot go into a command. */
function commandsFor(os: Endpoint["os"], instanceUrl: string) {
  if (os === "windows" || !isSafeOrigin(instanceUrl.replace(/\/+$/, ""))) {
    return null;
  }
  return installCommands(os, instanceUrl);
}

export async function getEndpoint(
  database: Database,
  tenantId: string,
  id: string,
  instanceUrl: string,
  options: DetailOptions = { revealHooks: false },
  now: Date = new Date(),
): Promise<EndpointDetailDto> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, id);
    const runs = await tx
      .select()
      .from(endpointRuns)
      .where(and(eq(endpointRuns.tenantId, tenantId), eq(endpointRuns.endpointId, id)))
      .orderBy(desc(endpointRuns.startedAt))
      .limit(20);
    const tasks = await tx
      .select()
      .from(endpointTasks)
      .where(
        and(
          eq(endpointTasks.tenantId, tenantId),
          eq(endpointTasks.endpointId, id),
          inArray(endpointTasks.status, ["pending", "delivered"]),
        ),
      )
      .orderBy(desc(endpointTasks.createdAt))
      .limit(20);
    // What happened to the last requests: done, or failed (expired, machine revoked, agent error).
    const recentTasks = await tx
      .select()
      .from(endpointTasks)
      .where(
        and(
          eq(endpointTasks.tenantId, tenantId),
          eq(endpointTasks.endpointId, id),
          inArray(endpointTasks.status, ["done", "failed"]),
        ),
      )
      .orderBy(desc(sql`coalesce(${endpointTasks.finishedAt}, ${endpointTasks.createdAt})`))
      .limit(RECENT_TASKS);
    const recentReports = await tx
      .select()
      .from(endpointReports)
      .where(and(eq(endpointReports.tenantId, tenantId), eq(endpointReports.endpointId, id)))
      .orderBy(desc(endpointReports.checkedAt))
      .limit(30);
    // The newest report of every kind as well: daily restore tests must not push the last
    // retention run or repository check out of the list (and the repository box blank).
    const latestPerKind = await tx
      .selectDistinctOn([endpointReports.kind])
      .from(endpointReports)
      .where(and(eq(endpointReports.tenantId, tenantId), eq(endpointReports.endpointId, id)))
      .orderBy(endpointReports.kind, desc(endpointReports.checkedAt));
    const listed = new Set(recentReports.map((report) => report.id));
    const reports = [
      ...recentReports,
      ...latestPerKind.filter((report) => !listed.has(report.id)),
    ].sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
    const readiness = await loadEndpointReadiness(tx, tenantId, [id], now);
    const rated = await loadRatedTests(tx, tenantId, runs, recentTasks);
    const jobsOf = await jobsOfEndpoints(tx, tenantId, [id]);
    const assignees = await loadAssignees(tx, tenantId, [endpoint.assignedUserId]);
    const summary = toSummary(
      endpoint,
      runs[0] ?? null,
      readinessOf(readiness, id),
      now,
      rated,
      jobsOf.get(id) ?? null,
      assigneeOf(assignees, endpoint),
    );
    const retention = latestPerKind.find((report) => report.kind === "retention");
    const [tenantUsage] = await tx
      .select({ bytes: sql<string | null>`sum(${endpoints.repositoryBytes})` })
      .from(endpoints)
      .where(eq(endpoints.tenantId, tenantId));
    const [tenantRow] = await tx
      .select({ paused: tenants.agentUpdatesPaused })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const all = commandsFor(endpoint.os, instanceUrl);
    const commands = all
      ? {
          uninstallScript: all.uninstallScript,
          uninstallAgent: all.uninstallAgent,
          hooksScripts: all.hooksScripts,
          hooksAny: all.hooksAny,
        }
      : null;
    return {
      ...summary,
      config: options.revealHooks ? endpoint.config : { ...endpoint.config, hooks: {} },
      configVersion: endpoint.configVersion,
      agentConfigVersion: endpoint.agentConfigVersion,
      settings: effectiveSettings(endpoint.settings),
      problems: problemsOf(endpoint, runs[0] ?? null, readinessOf(readiness, id), now),
      runs: runs.map((run) => toRunSummary(run, rated)),
      // Waiting tasks have no outcome yet.
      tasks: tasks.map((task) => toTask(task, NO_RATED_TESTS)),
      recentTasks: recentTasks.map((task) => toTask(task, rated)),
      reports: reports.map(toReport),
      repository: retention
        ? {
            bytes: retention.summary.repositoryBytes ?? null,
            snapshots: retention.summary.keptSnapshots ?? null,
            at: retention.checkedAt.toISOString(),
          }
        : null,
      storage: storageOf(endpoint, Number(tenantUsage?.bytes ?? 0), endpointQuotaLimits(), now),
      lastRetentionAt: endpoint.lastRetentionAt?.toISOString() ?? null,
      lastCheckAt: endpoint.lastCheckAt?.toISOString() ?? null,
      lastRestoreTestAt: endpoint.lastRestoreTestAt?.toISOString() ?? null,
      commands,
      hooks: hooksOf(endpoint.config, endpoint.settings, options.revealHooks),
      // Paused for this machine: the tenant's setting, or the machine's own pause.
      autoUpdatePaused: tenantRow?.paused === true || pausedOnItsOwn(endpoint.settings),
      autoUpdateOwnPause: pausedOnItsOwn(endpoint.settings),
    };
  });
}

export async function listRuns(
  database: Database,
  tenantId: string,
  id: string,
  limit: number,
): Promise<{ items: RunSummaryDto[] }> {
  return withTenantTx(database, tenantId, async (tx) => {
    await loadEndpoint(tx, tenantId, id);
    const rows = await tx
      .select()
      .from(endpointRuns)
      .where(and(eq(endpointRuns.tenantId, tenantId), eq(endpointRuns.endpointId, id)))
      .orderBy(desc(endpointRuns.startedAt))
      .limit(limit);
    const rated = await loadRatedTests(tx, tenantId, rows);
    return { items: rows.map((run) => toRunSummary(run, rated)) };
  });
}

export async function getRun(
  database: Database,
  tenantId: string,
  id: string,
  runId: string,
): Promise<RunDetailDto> {
  return withTenantTx(database, tenantId, async (tx) => {
    const [run] = await tx
      .select()
      .from(endpointRuns)
      .where(
        and(
          eq(endpointRuns.tenantId, tenantId),
          eq(endpointRuns.endpointId, id),
          eq(endpointRuns.id, runId),
        ),
      )
      .limit(1);
    if (!run) {
      throw new ProblemError(404, "Run not found");
    }
    return toRunDetail(run, await loadRatedTests(tx, tenantId, [run]));
  });
}

// ---------------------------------------------------------------------------
// Enrollment tokens
// ---------------------------------------------------------------------------

function toTokenDto(
  row: typeof endpointEnrollmentTokens.$inferSelect,
  now: Date,
): EnrollmentTokenDto {
  return {
    id: row.id,
    profile: row.profile,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    state: enrollmentTokenState(row, now),
    usedByEndpointId: row.usedByEndpointId,
  };
}

export async function createEnrollmentToken(
  database: Database,
  tenantId: string,
  input: { profile: Endpoint["profile"]; os: string; displayName?: string },
  actor: EndpointActor,
  instance: { url: string; configured: boolean },
  now: Date = new Date(),
): Promise<CreatedTokenDto> {
  if (!isSupportedEndpointOs(input.os)) {
    throw new ProblemError(422, "Operating system not supported", {
      type: UNSUPPORTED_OS_PROBLEM,
      detail:
        "Windows endpoints are not supported yet. This release backs up Linux and macOS machines.",
      extensions: { supported: ["linux", "darwin"] },
    });
  }
  if (input.os === "windows") {
    throw new ProblemError(422, "Operating system not supported", { type: UNSUPPORTED_OS_PROBLEM });
  }
  if (!instance.url || !isSafeOrigin(instance.url)) {
    throw new ProblemError(503, "Instance address unknown", {
      type: ENDPOINT_PROBLEMS.instanceUnknown,
      detail: "The public address of this installation is not configured.",
    });
  }
  const token = generateEnrollmentToken();
  const displayName = input.displayName?.trim() || null;
  const row = await withTenantTx(database, tenantId, async (tx) => {
    const [created] = await tx
      .insert(endpointEnrollmentTokens)
      .values({
        tenantId,
        tokenHash: token.hash,
        profile: input.profile,
        displayName,
        expiresAt: enrollmentTokenExpiry(now),
        createdBy: actor.userId,
        createdAt: now,
      })
      .returning();
    if (!created) {
      throw new Error("token insert returned no row");
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      ip: actor.ip,
      action: ENDPOINT_AUDIT_ACTIONS.tokenCreated,
      target: created.id,
      targetType: "endpoint_enrollment_token",
      details: {
        profile: input.profile,
        os: input.os,
        displayName,
        expiresAt: created.expiresAt.toISOString(),
      },
    });
    return created;
  });
  const warnings: CreatedTokenDto["warnings"] = [];
  if (isInsecureTransport(instance.url)) {
    warnings.push("insecure_transport");
  }
  if (!instance.configured) {
    warnings.push("instance_url_not_configured");
  }
  return {
    ...toTokenDto(row, now),
    token: token.value,
    os: input.os,
    instanceUrl: instance.url,
    commands: installCommands(input.os, instance.url),
    warnings,
  };
}

/**
 * The tenant's enrollment tokens, newest first. By default only the valid ones
 * (not used, not revoked, not expired), which are the ones an admin can still
 * act on; `state: "all"` adds the settled ones for a look back.
 */
export async function listEnrollmentTokens(
  database: Database,
  tenantId: string,
  filter: { state?: "valid" | "all" } = {},
  now: Date = new Date(),
): Promise<{ items: EnrollmentTokenDto[] }> {
  const validOnly = (filter.state ?? "valid") === "valid";
  return withTenantTx(database, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(endpointEnrollmentTokens)
      .where(
        and(
          eq(endpointEnrollmentTokens.tenantId, tenantId),
          validOnly
            ? and(
                isNull(endpointEnrollmentTokens.usedAt),
                isNull(endpointEnrollmentTokens.revokedAt),
                gt(endpointEnrollmentTokens.expiresAt, now),
              )
            : undefined,
        ),
      )
      .orderBy(desc(endpointEnrollmentTokens.createdAt))
      .limit(TOKEN_LIST_LIMIT);
    return { items: rows.map((row) => toTokenDto(row, now)) };
  });
}

export async function revokeEnrollmentToken(
  database: Database,
  tenantId: string,
  tokenId: string,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<void> {
  await withTenantTx(database, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(endpointEnrollmentTokens)
      .where(
        and(
          eq(endpointEnrollmentTokens.tenantId, tenantId),
          eq(endpointEnrollmentTokens.id, tokenId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new ProblemError(404, "Token not found");
    }
    if (row.usedAt || row.revokedAt) {
      throw new ProblemError(409, "Token already used or revoked", {
        type: ENDPOINT_PROBLEMS.tokenSettled,
        detail: "The token was used or revoked already.",
      });
    }
    await tx
      .update(endpointEnrollmentTokens)
      .set({ revokedAt: now })
      .where(eq(endpointEnrollmentTokens.id, tokenId));
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      ip: actor.ip,
      action: ENDPOINT_AUDIT_ACTIONS.tokenRevoked,
      target: tokenId,
      targetType: "endpoint_enrollment_token",
      details: { profile: row.profile },
    });
  });
}

// ---------------------------------------------------------------------------
// Changing an endpoint
// ---------------------------------------------------------------------------

const hashOf = hookFingerprint;

/**
 * Hooks run as root on the machine, so the machine decides (docs/AGENT.md,
 * "Hooks"): a hook can only be set when the agent reports that root on the
 * machine allows hooks from the server, and under the scripts policy only as
 * the name of a script in its hooks folder. Clearing hooks always works.
 */
export function assertHooksAllowed(
  hooks: { pre?: string; post?: string },
  settings: EndpointSettings,
): void {
  const values = [hooks.pre, hooks.post].filter((value): value is string => Boolean(value));
  if (values.length === 0) {
    return;
  }
  const policy = settings.agent?.hooks ?? null;
  if (policy !== "scripts" && policy !== "any") {
    throw new ProblemError(409, "Hooks not allowed on this machine", {
      type: ENDPOINT_PROBLEMS.hooksNotAllowed,
      detail:
        policy === "off"
          ? "This machine does not run hooks from the server. An administrator of the machine can allow them with `restow-agent hooks scripts` or `restow-agent hooks any`."
          : "The agent on this machine has not reported yet whether it allows hooks; it does with its next contact, an agent of an earlier pre-release installation once it has updated itself. Hooks can be set once it has reported it and an administrator of the machine allowed them.",
      extensions: { policy },
    });
  }
  if (policy === "scripts") {
    const invalid = values.filter((value) => !HOOK_SCRIPT_NAME.test(value.trim()));
    if (invalid.length > 0) {
      throw new ProblemError(422, "Hook is not a script name", {
        type: ENDPOINT_PROBLEMS.hookNotAScript,
        detail:
          "This machine only runs scripts from /etc/restow-agent/hooks.d. Enter the name of a script there, not a command.",
        extensions: { scripts: settings.agent?.hookScripts ?? [] },
      });
    }
  }
}

/** Apply a validated change to a configuration; returns the new one and which keys changed. */
export function applyConfigChange(
  current: EndpointConfig,
  change: NonNullable<UpdateEndpointInput["config"]>,
): { config: EndpointConfig; changed: string[] } {
  const next: EndpointConfig = { ...current, hooks: { ...current.hooks } };
  const changed: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (change.schedule !== undefined && !same(change.schedule, current.schedule)) {
    next.schedule = change.schedule;
    changed.push("schedule");
  }
  if (change.paths !== undefined && !same(change.paths, current.paths)) {
    next.paths = change.paths;
    changed.push("paths");
  }
  if (change.excludes !== undefined && !same(change.excludes, current.excludes)) {
    next.excludes = change.excludes;
    changed.push("excludes");
  }
  if (change.hooks !== undefined) {
    const hooks: { pre?: string; post?: string } = {};
    if (change.hooks.pre) hooks.pre = change.hooks.pre;
    if (change.hooks.post) hooks.post = change.hooks.post;
    if (!same(hooks, current.hooks)) {
      next.hooks = hooks;
      changed.push("hooks");
    }
  }
  if (change.bandwidthKbps !== undefined && change.bandwidthKbps !== current.bandwidthKbps) {
    next.bandwidthKbps = change.bandwidthKbps;
    changed.push("bandwidthKbps");
  }
  let config = next;
  if (change.bandwidthWindows !== undefined) {
    // null and [] both remove the windows; a list is stored in its normal order (updateEndpoint checked it).
    const wanted =
      change.bandwidthWindows === null || change.bandwidthWindows.length === 0
        ? null
        : normalizeBandwidthWindows(change.bandwidthWindows);
    // Compared by meaning: the database hands an object's keys back in an order of its own.
    if (!sameJson(wanted, current.bandwidthWindows ?? null)) {
      if (wanted) {
        next.bandwidthWindows = wanted;
      } else {
        const { bandwidthWindows: _removed, ...without } = next;
        config = without;
      }
      changed.push("bandwidthWindows");
    }
  }
  if (change.onlyOnAcPower !== undefined && change.onlyOnAcPower !== current.onlyOnAcPower) {
    config.onlyOnAcPower = change.onlyOnAcPower;
    changed.push("onlyOnAcPower");
  }
  return { config, changed };
}

/** A 422 for time windows that cannot be saved: the problem names the window and its field. */
function invalidBandwidthWindows(problem: { path: string[]; code: string; message: string }) {
  return new ProblemError(422, "Invalid time windows", {
    type: ENDPOINT_PROBLEMS.invalidBandwidthWindows,
    detail: problem.message,
    extensions: {
      field: "bandwidthWindows",
      code: problem.code,
      issues: [{ path: problem.path, code: problem.code, message: problem.message }],
    },
  });
}

/**
 * Whether a change of the hooks needs a recent sign-in (routes.ts, lib/recent-sign-in.ts): every
 * change after which the machine still has a hook, because a hook is a command or script that
 * runs as root there. Removing every hook needs none: the machine then runs less, never more, and
 * the settings offer exactly that for a machine that skips its hooks anyway.
 */
export function hookChangeNeedsRecentSignIn(hooks: EndpointConfig["hooks"]): boolean {
  return Boolean(hooks.pre || hooks.post);
}

export interface UpdateEndpointOptions {
  readonly now?: Date;
  /**
   * Called inside the change, after the machine's hook policy accepted the new hooks, when
   * {@link hookChangeNeedsRecentSignIn}; throws to refuse the whole change (the route passes
   * the step-up check of the session).
   */
  readonly confirmHookChange?: () => void;
}

/** A 409 for what only a machine in a backup job can do. */
function notInJob(detail: string): ProblemError {
  return new ProblemError(409, "Machine is in no backup job", {
    type: ENDPOINT_PROBLEMS.noJob,
    detail,
  });
}

/** A 422 for a person who is not in the tenant's protection directory. */
function assigneeUnknown(): ProblemError {
  return new ProblemError(422, "Person not in the directory", {
    type: ENDPOINT_PROBLEMS.assigneeUnknown,
    detail:
      "The person is not in this tenant's directory (any more). Choose a person from the directory.",
    extensions: { field: "assignedUserId" },
  });
}

function configManagedByJob(job: { id: string; name: string }): ProblemError {
  return new ProblemError(409, "Configuration managed by a backup job", {
    type: ENDPOINT_PROBLEMS.configManagedByJob,
    detail: `This machine belongs to the backup job "${job.name}", which decides its schedule, folders, exclusions, hooks and bandwidth. Change the job (or take the machine out of it).`,
    extensions: { job: { id: job.id, name: job.name } },
  });
}

export async function updateEndpoint(
  database: Database,
  tenantId: string,
  id: string,
  change: UpdateEndpointInput,
  actor: EndpointActor,
  options: UpdateEndpointOptions = {},
): Promise<{ configVersion: number; changed: string[] }> {
  const now = options.now ?? new Date();
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, id);
    if (endpoint.status !== "active") {
      throw new ProblemError(409, "Endpoint revoked", {
        type: ENDPOINT_PROBLEMS.revoked,
        detail: "A revoked endpoint cannot be changed.",
      });
    }
    const changed: string[] = [];
    const set: Partial<typeof endpoints.$inferInsert> = {};
    if (change.displayName !== undefined) {
      const name = change.displayName?.trim() || null;
      if (name !== endpoint.displayName) {
        set.displayName = name;
        changed.push("displayName");
      }
    }
    // The person the machine is assigned to: one of the tenant's protection directory, or nobody.
    let assignment: { previousUserId: string | null; person: EndpointAssigneeDto | null } | null =
      null;
    if (change.assignedUserId !== undefined && change.assignedUserId !== endpoint.assignedUserId) {
      const wanted = change.assignedUserId;
      const person =
        wanted === null
          ? null
          : ((await loadAssignees(tx, tenantId, [wanted])).get(wanted) ?? null);
      if (wanted !== null && person === null) {
        throw assigneeUnknown();
      }
      set.assignedUserId = wanted;
      changed.push("assignedUserId");
      assignment = { previousUserId: endpoint.assignedUserId, person };
    }
    const details: Record<string, unknown> = {};
    if (change.config?.bandwidthWindows) {
      const problem = bandwidthWindowsProblem(change.config.bandwidthWindows, [
        "config",
        "bandwidthWindows",
      ]);
      if (problem) {
        throw invalidBandwidthWindows(problem);
      }
    }
    // A machine in a backup job takes its schedule, folders, exclusions, hooks, bandwidth (and the
    // retention when the job sets one) from the job; those are changed there, nowhere else.
    const managed = await jobWithOverridesOf(tx, tenantId, id);
    if (change.config) {
      const applied = applyConfigChange(endpoint.config, change.config);
      if (managed && applied.changed.some((key) => key !== "onlyOnAcPower")) {
        throw configManagedByJob(managed.job);
      }
      // Backups run only in a job (release 0.2.1): a machine in none may stop its schedule (`none`)
      // but not start one. Its folders and the rest stay changeable; they take effect in a job.
      if (applied.changed.includes("schedule")) {
        if (!isUnscheduled(applied.config.schedule)) {
          throw notInJob(
            "Backups run in backup jobs: add this machine to a job, which sets when it backs up.",
          );
        }
        applied.config.schedule = noSchedule(applied.config.schedule.timeZone);
      }
      if (applied.changed.includes("hooks")) {
        assertHooksAllowed(applied.config.hooks, endpoint.settings);
        if (hookChangeNeedsRecentSignIn(applied.config.hooks)) {
          options.confirmHookChange?.();
        }
      }
      if (applied.changed.length > 0) {
        set.config = applied.config;
        set.configVersion = endpoint.configVersion + 1;
        changed.push(...applied.changed.map((key) => `config.${key}`));
        if (applied.changed.includes("hooks")) {
          // Hooks run as root on the endpoint: record that they changed and a fingerprint, not their text.
          details.hooks = {
            pre: hashOf(applied.config.hooks.pre),
            post: hashOf(applied.config.hooks.post),
          };
        }
        if (applied.changed.includes("paths")) details.paths = applied.config.paths;
        if (applied.changed.includes("schedule")) details.schedule = applied.config.schedule;
      }
    }
    if (change.settings) {
      if (
        managed &&
        change.settings.retention !== undefined &&
        jobRetentionOf(managed) !== undefined &&
        JSON.stringify(change.settings.retention) !== JSON.stringify(endpoint.settings.retention)
      ) {
        throw configManagedByJob(managed.job);
      }
      const merged: EndpointSettings = { ...endpoint.settings, ...change.settings };
      // No budget of its own: the installation's default applies again.
      if (merged.quotaGib === null) {
        merged.quotaGib = undefined;
      }
      if (JSON.stringify(merged) !== JSON.stringify(endpoint.settings)) {
        set.settings = merged;
        changed.push(...Object.keys(change.settings).map((key) => `settings.${key}`));
        details.settings = change.settings;
      }
    }
    if (changed.length === 0) {
      return { configVersion: endpoint.configVersion, changed };
    }
    await tx.update(endpoints).set(set).where(eq(endpoints.id, id));
    if (set.configVersion !== undefined) {
      // Tell the agent to fetch it now instead of at its next scheduled look.
      await tx.insert(endpointTasks).values({
        tenantId,
        endpointId: id,
        kind: "update_config",
        params: { configVersion: set.configVersion },
        createdBy: actor.userId,
        createdAt: now,
      });
    }
    // The assignment has an audit entry of its own; everything else is a change of the machine.
    const configChanges = changed.filter((key) => key !== "assignedUserId");
    if (configChanges.length > 0) {
      await auditEndpoint(tx, {
        tenantId,
        actor,
        action: ENDPOINT_AUDIT_ACTIONS.configChanged,
        endpointId: id,
        details: { hostname: endpoint.hostname, changed: configChanges, ...details },
      });
    }
    if (assignment) {
      await auditEndpoint(tx, {
        tenantId,
        actor,
        action: ENDPOINT_AUDIT_ACTIONS.assigned,
        endpointId: id,
        details: {
          hostname: endpoint.hostname,
          assignedUserId: assignment.person?.id ?? null,
          assignedEmail: assignment.person?.email ?? null,
          previousUserId: assignment.previousUserId,
        },
      });
    }
    return { configVersion: set.configVersion ?? endpoint.configVersion, changed };
  });
}

export async function revokeEndpoint(
  database: Database,
  tenantId: string,
  id: string,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<void> {
  await withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, id);
    if (endpoint.status === "revoked") {
      return;
    }
    await tx
      .update(endpoints)
      .set({ status: "revoked", revokedAt: now })
      .where(eq(endpoints.id, id));
    await tx
      .update(endpointTasks)
      .set({ status: "failed", finishedAt: now, errorMessage: "endpoint revoked" })
      .where(
        and(
          eq(endpointTasks.endpointId, id),
          inArray(endpointTasks.status, ["pending", "delivered"]),
        ),
      );
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.revoked,
      endpointId: id,
      details: { hostname: endpoint.hostname, reason: "admin" },
    });
  });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const FULL_SNAPSHOT_ID = /^[0-9a-f]{64}$/i;

export async function createTask(
  database: Database,
  tenantId: string,
  id: string,
  input: CreateTaskInput,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<{ task: TaskDto; alreadyQueued: boolean }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, id);
    if (endpoint.status !== "active") {
      throw new ProblemError(409, "Endpoint revoked", {
        type: ENDPOINT_PROBLEMS.revoked,
        detail: "A revoked endpoint takes no tasks.",
      });
    }
    if (input.kind === "restore" && !FULL_SNAPSHOT_ID.test(input.snapshotId)) {
      throw new ProblemError(422, "Validation failed", {
        detail: "A restore names a snapshot by its full id.",
      });
    }
    if (input.kind === "backup_now" && !(await jobWithOverridesOf(tx, tenantId, id))) {
      throw notInJob(
        "This machine is in no backup job, so it has nothing to back up. Add it to a job first.",
      );
    }
    // One waiting backup request is enough.
    if (input.kind === "backup_now") {
      const [existing] = await tx
        .select()
        .from(endpointTasks)
        .where(
          and(
            eq(endpointTasks.endpointId, id),
            eq(endpointTasks.kind, "backup_now"),
            inArray(endpointTasks.status, ["pending", "delivered"]),
          ),
        )
        .limit(1);
      if (existing) {
        return { task: toTask(existing, NO_RATED_TESTS), alreadyQueued: true };
      }
    }
    const params: Record<string, unknown> =
      input.kind === "restore"
        ? {
            snapshotId: input.snapshotId,
            paths: input.paths,
            ...(input.targetDir ? { targetDir: input.targetDir } : {}),
          }
        : {};
    const [task] = await tx
      .insert(endpointTasks)
      .values({
        tenantId,
        endpointId: id,
        kind: input.kind,
        params,
        createdBy: actor.userId,
        createdAt: now,
        // A restore or backup request that no agent picks up within a week is stale.
        expiresAt: new Date(now.getTime() + AGENT_TASK_TTL_MS),
      })
      .returning();
    if (!task) {
      throw new Error("task insert returned no row");
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action:
        input.kind === "backup_now"
          ? ENDPOINT_AUDIT_ACTIONS.backupRequested
          : ENDPOINT_AUDIT_ACTIONS.restoreRequested,
      endpointId: id,
      details: {
        hostname: endpoint.hostname,
        taskId: task.id,
        ...(input.kind === "restore"
          ? {
              snapshotId: input.snapshotId,
              paths: input.paths.slice(0, 50),
              pathCount: input.paths.length,
              targetDir: input.targetDir ?? null,
            }
          : {}),
      },
    });
    return { task: toTask(task, NO_RATED_TESTS), alreadyQueued: false };
  });
}

/**
 * Uninstall the agent: the task is delivered with the next heartbeat, and the
 * endpoint is revoked when it is (the agent removes itself; its repository
 * stays restorable).
 */
export async function requestUninstall(
  database: Database,
  tenantId: string,
  id: string,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<{ task: TaskDto; alreadyQueued: boolean }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, id);
    if (endpoint.status !== "active") {
      throw new ProblemError(409, "Endpoint revoked", {
        type: ENDPOINT_PROBLEMS.revoked,
        detail: "A revoked endpoint takes no tasks.",
      });
    }
    const [existing] = await tx
      .select()
      .from(endpointTasks)
      .where(
        and(
          eq(endpointTasks.endpointId, id),
          eq(endpointTasks.kind, "uninstall"),
          inArray(endpointTasks.status, ["pending", "delivered"]),
        ),
      )
      .limit(1);
    if (existing) {
      return { task: toTask(existing, NO_RATED_TESTS), alreadyQueued: true };
    }
    const [task] = await tx
      .insert(endpointTasks)
      .values({
        tenantId,
        endpointId: id,
        kind: "uninstall",
        params: {},
        createdBy: actor.userId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + AGENT_TASK_TTL_MS),
      })
      .returning();
    if (!task) {
      throw new Error("task insert returned no row");
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.uninstallRequested,
      endpointId: id,
      details: { hostname: endpoint.hostname, taskId: task.id },
    });
    return { task: toTask(task, NO_RATED_TESTS), alreadyQueued: false };
  });
}

/** Ask the worker for a restore test of the newest backup now. */
export async function requestRestoreTest(
  database: Database,
  tenantId: string,
  id: string,
  actor: EndpointActor,
): Promise<{ queued: boolean }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, id);
    if (endpoint.status !== "active" || !endpoint.lastSnapshotId) {
      throw new ProblemError(409, "Nothing to test", {
        type: ENDPOINT_PROBLEMS.nothingToTest,
        detail: "The endpoint has no good backup to test yet.",
      });
    }
    const payload: EndpointJobPayload = { tenantId, endpointId: id, force: true };
    let queued = false;
    try {
      const jobId = await jobQueue(database).send(ENDPOINT_QUEUES.verify, payload, {
        singletonKey: endpointSingletonKey(ENDPOINT_QUEUES.verify, id),
        db: pgBossExecutor(tx),
      });
      queued = jobId !== null && jobId !== undefined;
    } catch (error) {
      if (!isMissingQueueSchema(error)) {
        throw error;
      }
      throw new ProblemError(503, "Job queue not ready", {
        type: ENDPOINT_PROBLEMS.queueNotReady,
        detail: "The worker has not started yet. Try again in a moment.",
      });
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.restoreTestRequested,
      endpointId: id,
      details: { hostname: endpoint.hostname, snapshotId: endpoint.lastSnapshotId, queued },
    });
    return { queued };
  });
}

// ---------------------------------------------------------------------------
// Snapshots, browsing, downloads (restic on the server)
// ---------------------------------------------------------------------------

/**
 * The endpoint and how to open its repository for a read. Opening holds the
 * repository for the read (shared with other reads, never beside retention or
 * the check, see `holdRepositoryForRead`) until the opened repository is
 * closed.
 */
async function openFor(
  database: Database,
  tenantId: string,
  id: string,
): Promise<{ endpoint: Endpoint; open: () => Promise<OpenRepository> }> {
  const endpoint = await withTenantTx(database, tenantId, (tx) => loadEndpoint(tx, tenantId, id));
  const access = await repositoryAccess(database, endpoint);
  const open = async (): Promise<OpenRepository> => {
    const release = await holdRepositoryForRead(database, id);
    try {
      const repository = await openRepository(access);
      return {
        session: repository.session,
        close: async () => {
          try {
            await repository.close();
          } finally {
            await release();
          }
        },
      };
    } catch (error) {
      await release();
      throw error;
    }
  };
  return { endpoint, open };
}

export async function listSnapshots(
  database: Database,
  tenantId: string,
  id: string,
): Promise<{ items: SnapshotDto[] }> {
  const { open } = await openFor(database, tenantId, id);
  const snapshots = await resticGate.run(tenantId, async () => {
    const repository = await open();
    try {
      return await resticSnapshots(repository.session);
    } catch (error) {
      throw resticProblem(error);
    } finally {
      await repository.close();
    }
  });
  const ratings = await withTenantTx(database, tenantId, async (tx) => {
    const rows = await tx
      .select({
        snapshotId: endpointReports.snapshotId,
        readiness: endpointReports.readiness,
        checkedAt: endpointReports.checkedAt,
        origin: endpointReports.origin,
      })
      .from(endpointReports)
      .where(
        and(
          eq(endpointReports.tenantId, tenantId),
          eq(endpointReports.endpointId, id),
          eq(endpointReports.kind, "restore_test"),
          isNotNull(endpointReports.snapshotId),
        ),
      )
      .orderBy(desc(endpointReports.checkedAt));
    const bySnapshot = new Map<string, SnapshotDto["verification"]>();
    for (const row of rows) {
      const current = bySnapshot.get(row.snapshotId as string);
      // Any failed origin rates the snapshot red; else the newest green counts.
      if (row.readiness === "red") {
        bySnapshot.set(row.snapshotId as string, {
          state: "red",
          checkedAt: row.checkedAt.toISOString(),
        });
      } else if (!current && row.readiness === "green") {
        bySnapshot.set(row.snapshotId as string, {
          state: "green",
          checkedAt: row.checkedAt.toISOString(),
        });
      }
    }
    return bySnapshot;
  });
  const flags = await withTenantTx(database, tenantId, async (tx) => {
    const rows = await tx
      .select({
        snapshotId: endpointSnapshotFlags.snapshotId,
        reasons: endpointSnapshotFlags.reasons,
      })
      .from(endpointSnapshotFlags)
      .where(
        and(eq(endpointSnapshotFlags.tenantId, tenantId), eq(endpointSnapshotFlags.endpointId, id)),
      );
    return new Map<string, SnapshotFlagReason[]>(rows.map((row) => [row.snapshotId, row.reasons]));
  });
  return {
    items: snapshots.map((snapshot) => ({
      id: snapshot.id,
      shortId: snapshot.shortId,
      time: snapshot.time,
      hostname: snapshot.hostname,
      paths: snapshot.paths,
      filesNew: snapshot.filesNew,
      totalFilesProcessed: snapshot.totalFilesProcessed,
      totalBytesProcessed: snapshot.totalBytesProcessed,
      verification: ratings.get(snapshot.id) ?? { state: "unverified", checkedAt: null },
      flags: flags.get(snapshot.id) ?? [],
    })),
  };
}

/** Where a browse cursor points: after the last entry of the previous page. */
const browseCursorSchema = z.object({ g: z.enum(["0", "1"]), n: z.string().min(1).max(4096) });

function browseCursorFor(entry: { type: string; name: string }): string {
  return encodeCursor({ g: entry.type === "dir" ? "0" : "1", n: entry.name });
}

function decodeBrowseCursor(raw: string | undefined): DirectoryPosition | null {
  try {
    const cursor = decodeCursor(browseCursorSchema, raw);
    return cursor ? { folder: cursor.g === "0", name: cursor.n } : null;
  } catch (error) {
    if (error instanceof ProblemError) {
      throw new ProblemError(400, "Invalid cursor", {
        type: ENDPOINT_PROBLEMS.invalidCursor,
        detail:
          "The cursor is not one this folder listing issued. Start again from the first page.",
      });
    }
    throw error;
  }
}

/**
 * One page of a folder of a snapshot: folders first, then by name. A folder
 * with more entries than `limit` answers with a `nextCursor` for the next
 * page. Every page read is audited.
 */
export async function browseSnapshot(
  database: Database,
  tenantId: string,
  id: string,
  query: { snapshotId: string; path: string; limit: number; cursor?: string },
  actor: EndpointActor,
  signal?: AbortSignal,
): Promise<BrowseDto> {
  const after = decodeBrowseCursor(query.cursor);
  const { endpoint, open } = await openFor(database, tenantId, id);
  const listing = await resticGate.run(tenantId, async () => {
    const repository = await open();
    try {
      return await resticListDirectory(repository.session, query.snapshotId, query.path, {
        limit: query.limit,
        after,
        signal,
      });
    } catch (error) {
      throw resticProblem(error);
    } finally {
      await repository.close();
    }
  });
  const last = listing.entries.at(-1);
  const nextCursor = listing.hasMore && last ? browseCursorFor(last) : null;
  await withTenantTx(database, tenantId, (tx) =>
    auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.browse,
      endpointId: id,
      details: {
        hostname: endpoint.hostname,
        snapshotId: query.snapshotId,
        path: query.path,
        entries: listing.entries.length,
        continued: after !== null,
        more: nextCursor !== null,
      },
    }),
  );
  return {
    snapshotId: query.snapshotId,
    path: query.path,
    entries: listing.entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: entry.type,
      size: entry.size,
      mtime: entry.mtime,
    })),
    nextCursor,
  };
}

export interface DownloadStream {
  stream: Readable;
  fileName: string;
}

/** How long a prepared download can be started, and how long its row is kept. */
export const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_KEEP_MS = 60 * 60 * 1000;

function downloadGone(): ProblemError {
  return new ProblemError(404, "Download not found", {
    type: ENDPOINT_PROBLEMS.downloadGone,
    detail: "The download is unknown, has expired or was started already. Prepare it again.",
  });
}

/**
 * Step one of a ZIP download: check the selection against the snapshot and
 * keep it. The paths come in the body (a selection can hold thousands, which
 * no URL carries), every one of them is looked up before any byte is sent, so
 * a wrong path is a clean 404 here and not a broken download later. The answer
 * is a short-lived, single-use download that only the admin who asked for it
 * can start ({@link openDownload}).
 */
export async function prepareDownload(
  database: Database,
  tenantId: string,
  id: string,
  input: CreateDownloadInput,
  actor: EndpointActor,
  signal?: AbortSignal,
  now: Date = new Date(),
): Promise<PreparedDownloadDto> {
  const { open } = await openFor(database, tenantId, id);
  const release = resticGate.acquire(tenantId);
  let repository: Awaited<ReturnType<typeof open>> | null = null;
  try {
    repository = await open();
    const selection = await resolveSelection(repository.session, input.snapshotId, input.paths, {
      signal,
    }).catch((error) => {
      if (error instanceof SelectionError) {
        throw new ProblemError(404, "Path not found in the snapshot", {
          type: ENDPOINT_PROBLEMS.pathNotFound,
          detail: "A selected path is not a file or folder of this snapshot.",
        });
      }
      throw resticProblem(error);
    });
    const expiresAt = new Date(now.getTime() + DOWNLOAD_TTL_MS);
    const row = await withTenantTx(database, tenantId, async (tx) => {
      // Downloads nobody started pile up only for an hour; the monitor sweeps the rest.
      await tx
        .delete(endpointDownloads)
        .where(
          and(
            eq(endpointDownloads.tenantId, tenantId),
            lt(endpointDownloads.expiresAt, new Date(now.getTime() - DOWNLOAD_KEEP_MS)),
          ),
        );
      const [created] = await tx
        .insert(endpointDownloads)
        .values({
          tenantId,
          endpointId: id,
          snapshotId: input.snapshotId,
          selection,
          createdBy: actor.userId,
          createdAt: now,
          expiresAt,
        })
        .returning();
      if (!created) {
        throw new Error("download insert returned no row");
      }
      return created;
    });
    return {
      id: row.id,
      expiresAt: row.expiresAt.toISOString(),
      items: selection.length,
    };
  } finally {
    if (repository) {
      await repository.close().catch(() => undefined);
    }
    release();
  }
}

/**
 * Step two: start a prepared download. It is claimed atomically (once, before
 * the expiry, by the admin who prepared it), the read is audited before the
 * first byte, and the ZIP is streamed from `restic dump`. The slot in the
 * restic gate and the maintenance listener are held until the stream ends,
 * whichever way.
 */
export async function openDownload(
  database: Database,
  tenantId: string,
  id: string,
  downloadId: string,
  actor: EndpointActor,
  signal?: AbortSignal,
  now: Date = new Date(),
): Promise<DownloadStream> {
  const { endpoint, open } = await openFor(database, tenantId, id);
  // A busy server, or a repository under maintenance, refuses here, before the download is spent.
  const release = resticGate.acquire(tenantId);
  let repository: Awaited<ReturnType<typeof open>> | null = null;
  try {
    repository = await open();
    const download = await withTenantTx(database, tenantId, async (tx) => {
      const [claimed] = await tx
        .update(endpointDownloads)
        .set({ startedAt: now })
        .where(
          and(
            eq(endpointDownloads.tenantId, tenantId),
            eq(endpointDownloads.endpointId, id),
            eq(endpointDownloads.id, downloadId),
            actor.userId
              ? eq(endpointDownloads.createdBy, actor.userId)
              : isNull(endpointDownloads.createdBy),
            isNull(endpointDownloads.startedAt),
            gt(endpointDownloads.expiresAt, now),
          ),
        )
        .returning();
      return claimed ?? null;
    });
    if (!download) {
      throw downloadGone();
    }
    await withTenantTx(database, tenantId, (tx) =>
      auditEndpoint(tx, {
        tenantId,
        actor,
        action: ENDPOINT_AUDIT_ACTIONS.download,
        endpointId: id,
        details: {
          hostname: endpoint.hostname,
          snapshotId: download.snapshotId,
          downloadId: download.id,
          paths: download.selection.slice(0, 50).map((item) => item.path),
          pathCount: download.selection.length,
        },
      }),
    );
    const zip = streamSnapshotZip({
      session: repository.session,
      snapshotId: download.snapshotId,
      paths: download.selection.map((item) => item.path),
      selection: download.selection,
      signal,
      comment: `Restow endpoint backup, ${endpoint.hostname}, snapshot ${download.snapshotId.slice(0, 8)}`,
    });
    const opened = repository;
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      void opened.close().finally(release);
    };
    zip.stream.once("close", finish);
    zip.stream.once("error", finish);
    return { stream: zip.stream, fileName: `${endpoint.hostname}-${zip.fileName}` };
  } catch (error) {
    if (repository) {
      await repository.close().catch(() => undefined);
    }
    release();
    throw error;
  }
}

export interface RepositoryKeyDto {
  /** The restic repository password. Shown on request, never stored in a response cache. */
  password: string;
  /** Where the repository lives inside the tenant's primary storage target. */
  storagePrefix: string;
}

/**
 * The repository password, for a restore without Restow: the repository is a
 * plain restic repository (docs/AGENT.md), so `restic -r <path> restore ...`
 * opens it with this password whether or not this server still runs. Handing
 * it out is a key access and is audited.
 */
export async function revealRepositoryPassword(
  database: Database,
  tenantId: string,
  id: string,
  actor: EndpointActor,
): Promise<RepositoryKeyDto> {
  const endpoint = await withTenantTx(database, tenantId, (tx) => loadEndpoint(tx, tenantId, id));
  const access = await repositoryAccess(database, endpoint);
  await withTenantTx(database, tenantId, (tx) =>
    auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.repositoryPasswordRevealed,
      endpointId: id,
      details: { hostname: endpoint.hostname },
    }),
  );
  return { password: access.repositoryPassword, storagePrefix: access.prefix };
}

/** Tasks that wait for or run on an endpoint (for tests and the detail page). */
export async function pendingTaskCount(
  database: Database,
  tenantId: string,
  id: string,
): Promise<number> {
  return withTenantTx(database, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: endpointTasks.id })
      .from(endpointTasks)
      .where(
        and(
          eq(endpointTasks.tenantId, tenantId),
          eq(endpointTasks.endpointId, id),
          ne(endpointTasks.status, "done"),
          ne(endpointTasks.status, "failed"),
        ),
      );
    return rows.length;
  });
}

export type { ReportDto };
export type { ResticError };

// ---------------------------------------------------------------------------
// Automatic agent updates (one setting per tenant)
// ---------------------------------------------------------------------------

export interface AgentUpdatesDto {
  /** The tenant paused automatic agent updates (one setting for the whole tenant). */
  paused: boolean;
  /** Machines of the tenant. */
  endpoints: number;
  /**
   * Machines that are paused on their own (`settings.autoUpdatePaused`, how the pause was kept
   * before it became a setting of the tenant): they stay paused whatever the tenant says, until
   * they are resumed one by one or all at once.
   */
  overrides: { id: string; name: string; profile: "server" | "client" }[];
}

/** Whether `settings` pauses the machine on its own. */
function pausedOnItsOwn(settings: EndpointSettings): boolean {
  return settings.autoUpdatePaused === true;
}

/**
 * The tenant's pause (`tenants.agent_updates_paused`) and the machines paused on their own.
 * A machine takes no new agent release while the tenant pause or its own pause is set.
 */
export async function getAgentUpdates(
  database: Database,
  tenantId: string,
): Promise<AgentUpdatesDto> {
  return withTenantTx(database, tenantId, (tx) => readAgentUpdates(tx, tenantId));
}

async function readAgentUpdates(tx: Transaction, tenantId: string): Promise<AgentUpdatesDto> {
  const [tenant] = await tx
    .select({ paused: tenants.agentUpdatesPaused })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const machines = await tx
    .select({
      id: endpoints.id,
      displayName: endpoints.displayName,
      hostname: endpoints.hostname,
      profile: endpoints.profile,
      settings: endpoints.settings,
    })
    .from(endpoints)
    .where(eq(endpoints.tenantId, tenantId))
    .orderBy(endpoints.hostname);
  return {
    paused: tenant?.paused === true,
    endpoints: machines.length,
    overrides: machines
      .filter((machine) => pausedOnItsOwn(machine.settings))
      .map((machine) => ({
        id: machine.id,
        name: machine.displayName?.trim() || machine.hostname,
        profile: machine.profile,
      })),
  };
}

export interface SetAgentUpdatesOptions {
  /** Also lift the pause of every machine that is paused on its own. */
  resumeMachines?: boolean;
}

/**
 * Pause or resume automatic agent updates for the tenant. It is one setting of the tenant, so it
 * can be set before the first machine exists and covers machines that enrol later. The machines'
 * own pauses are left alone unless `resumeMachines` asks to lift them as well.
 */
export async function setAgentUpdates(
  database: Database,
  tenantId: string,
  paused: boolean,
  actor: EndpointActor,
  options: SetAgentUpdatesOptions = {},
): Promise<AgentUpdatesDto> {
  return withTenantTx(database, tenantId, async (tx) => {
    await tx.update(tenants).set({ agentUpdatesPaused: paused }).where(eq(tenants.id, tenantId));
    let resumed = 0;
    if (options.resumeMachines === true) {
      const lifted = await tx
        .update(endpoints)
        .set({ settings: sql`${endpoints.settings} - 'autoUpdatePaused'` })
        .where(
          and(
            eq(endpoints.tenantId, tenantId),
            sql`(${endpoints.settings} ->> 'autoUpdatePaused') = 'true'`,
          ),
        )
        .returning({ id: endpoints.id });
      resumed = lifted.length;
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      ip: actor.ip,
      action: paused ? ENDPOINT_AUDIT_ACTIONS.updatesPaused : ENDPOINT_AUDIT_ACTIONS.updatesResumed,
      target: tenantId,
      targetType: "tenant",
      details: { machinesResumed: resumed },
    });
    return readAgentUpdates(tx, tenantId);
  });
}

/** Lift the own pause of one machine (it then follows the tenant's setting again). */
export async function resumeMachineUpdates(
  database: Database,
  tenantId: string,
  endpointId: string,
  actor: EndpointActor,
): Promise<AgentUpdatesDto> {
  return withTenantTx(database, tenantId, async (tx) => {
    const lifted = await tx
      .update(endpoints)
      .set({ settings: sql`${endpoints.settings} - 'autoUpdatePaused'` })
      .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.id, endpointId)))
      .returning({ id: endpoints.id });
    if (lifted.length === 0) {
      throw new ProblemError(404, "Machine not found");
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      ip: actor.ip,
      action: ENDPOINT_AUDIT_ACTIONS.updatesResumed,
      target: endpointId,
      targetType: "endpoint",
      details: { machine: true },
    });
    return readAgentUpdates(tx, tenantId);
  });
}
