import { randomBytes, randomUUID } from "node:crypto";
import {
  type AgentConfigResponse,
  agentFacingConfig,
  agentPolicyWire,
  bandwidthTimeZone,
  buildCause,
  cleanDataFolderReport,
  DEFAULT_SCHEDULE_TIMEZONE,
  ENDPOINT_QUEUES,
  type EndpointJobPayload,
  effectiveBandwidthKbps,
  endpointPasswordKey,
  endpointSingletonKey,
  enrolledEndpointConfig,
  enrollmentProfile,
  enrollmentTokenState,
  failureOfRun,
  generateAgentSecret,
  hashSecret,
  isInterruptedOnly,
  isSupportedEndpointOs,
  isSupportedEndpointTarget,
  isValidTimeZone,
  judgeAgentRestoreTest,
  parseActivityReport,
  parseRunConsistency,
  policyBandwidthDefault,
  policyOnlyOnAcPower,
  RESTIC_VERSION,
  type RestoreTestTaskParams,
  redactAgentLog,
  redactAgentMessage,
  resolveFsSnapshot,
  resticInit,
  restoreTestAlreadyWaiting,
  restoreTestRetry,
  type StorageBackend,
  SUPPORTED_ENDPOINT_OS,
  sealEndpointPassword,
  toFailureRecord,
  withDeletionPermit,
} from "@restow/core";
import {
  type Endpoint,
  type EndpointAgentFacts,
  type EndpointConfig,
  type EndpointRun,
  type EndpointRunStats,
  endpointEnrollmentTokens,
  endpointReports,
  endpointRuns,
  endpointSamples,
  endpoints,
  endpointTasks,
  type JobStartPauseState,
  lockTenantStorage,
  NOT_PAUSED,
  readJobStartPause,
  runSizeHoldOfRun,
  tenants,
} from "@restow/db";
import { and, asc, eq, inArray, isNull, lt, notInArray, or, type SQL, sql } from "drizzle-orm";
import { config as appConfig } from "../../config.js";
import { db, providerDb } from "../../db.js";
import { loadTenantDek, storeSecret } from "../../lib/secrets.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { emitWebhookEvent } from "../../lib/webhooks.js";
import { ProblemError } from "../../problem.js";
import { pgBossExecutor } from "../jobs/pg-boss-tx.js";
import { jobQueue } from "../jobs/queue.js";
import { RESTORE_MODE_TASK_HOLD_MESSAGE, restoreModeTaskHoldBefore } from "../restore-mode/hold.js";
import { readFromIn } from "../storage/repository-source.js";
import { type AgentContext, FailureTracker } from "./agent-auth.js";
import { agentActor, auditEndpoint, ENDPOINT_AUDIT_ACTIONS } from "./audit.js";
import { storeRunLayout } from "./baremetal.js";
import { type AgentCancelOrders, agentCancelOrders } from "./cancel.js";
import {
  announcedAgentVersion,
  compareAgentVersions,
  isAgentVersion,
  latestAgentRelease,
} from "./distribution.js";
import { wholeMachineSent } from "./dto.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import { claimEnrollmentToken, rotateEndpointSecret } from "./rebind.js";
import {
  forgetTenantStorage,
  REPOSITORY_SECRET_KIND,
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
import {
  recordSqlBackupRun,
  recordSqlInventory,
  recordSqlRestoreRun,
  recordSqlVerifyRun,
  runNoticesOf,
  withSqlStats,
} from "./sql-agent.js";

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
  kind:
    | "backup_now"
    | "restore"
    | "verify_sample"
    | "update_config"
    | "uninstall"
    | "sql_restore"
    | "sql_verify"
    | "sql_inventory";
  params: Record<string, unknown>;
}

export interface EnrollResponse {
  endpointId: string;
  agentSecret: string;
  repository: { url: string; password: string };
  config: AgentConfigResponse;
  restic: { version: string };
  /**
   * A rebind token was redeemed (0.5.0, docs/BAREMETAL.md 11): the existing machine got a new
   * secret and kept its backups. Absent for a new machine; an older agent ignores it.
   */
  rebound?: true;
}

/**
 * What `GET /agent/v1/config` answers: the stored configuration, without the bandwidth windows
 * (the agent does not know them) and with `bandwidthKbps` as the limit that applies at `now`, the
 * active window's, else the default. The stored configuration and its version are never touched
 * by a window starting or ending, so the agent's cached copy never goes stale because of one; it
 * asks again when a backup starts and then gets the limit of that moment. A machine in no backup
 * job (schedule `none`) is sent no folders and no hooks (`agentFacingConfig`): an agent older
 * than 0.2.1 does not know `none` and would otherwise back them up on its profile's default.
 *
 * Whole machine backups (docs/BAREMETAL.md 5.1, 6.1; agents from 0.5.0, an older one ignores both
 * fields): `wholeMachine: true` only while RESTOW_BAREMETAL_PREVIEW is on and for a Linux machine
 * whose job writes it, so switching the preview off takes effect with the agent's next fetch (it
 * fetches before every backup). `fsSnapshot` goes to Linux and macOS machines (never Windows,
 * which has `useVss`): the machine's own setting, else on for a whole machine and off otherwise.
 * Without `os` neither is sent.
 */
export function configResponse(
  config: EndpointConfig,
  configVersion: number,
  effective?: { zone: string; now: Date },
  options: { startsPaused?: boolean; os?: string; baremetalPreview?: boolean } = {},
): AgentConfigResponse {
  const {
    bandwidthWindows,
    policy,
    wholeMachine: storedWhole,
    fsSnapshot: storedSnapshot,
    ...rest
  } = agentFacingConfig(config);
  const wholeMachine = wholeMachineSent(storedWhole, options.os, options.baremetalPreview);
  const snapshotFields =
    options.os === "linux"
      ? {
          ...(wholeMachine ? { wholeMachine: true } : {}),
          fsSnapshot: resolveFsSnapshot(storedSnapshot, wholeMachine),
        }
      : // macOS gets its APFS snapshots with M6; until then it never takes one.
        options.os === "darwin"
        ? { fsSnapshot: "off" as const }
        : {};
  // The agent policy (docs/AGENT.md, "Richtlinien"): the limit of a job without its own and a lock
  // decide the default limit and whether its windows apply, AC power is folded in, and the rest
  // (window, catch-up, retries) goes along in its wire form. Without a policy nothing changes.
  const bandwidth = policyBandwidthDefault(
    config.bandwidthKbps,
    (bandwidthWindows?.length ?? 0) > 0,
    policy,
  );
  const paused = options.startsPaused === undefined ? {} : { startsPaused: options.startsPaused };
  const policyFields = policy
    ? {
        onlyOnAcPower: policyOnlyOnAcPower(config.onlyOnAcPower, policy),
        policy: agentPolicyWire(policy, effective?.zone ?? config.schedule.timeZone),
      }
    : {};
  if (!bandwidth.windows || !bandwidthWindows || !effective) {
    return {
      ...rest,
      bandwidthKbps: bandwidth.kbps,
      ...policyFields,
      ...paused,
      ...snapshotFields,
      configVersion,
    };
  }
  return {
    ...rest,
    bandwidthKbps: effectiveBandwidthKbps(
      bandwidth.kbps,
      bandwidthWindows,
      effective.zone,
      effective.now,
    ),
    ...policyFields,
    ...paused,
    ...snapshotFields,
    configVersion,
  };
}

/** Whether an update pauses new runs (#46); unreadable counts as not paused. */
export async function agentStartsPaused(): Promise<boolean> {
  return (await agentStartPause()).paused;
}

async function agentStartPause(): Promise<JobStartPauseState> {
  try {
    return await readJobStartPause(providerDb.$client);
  } catch {
    return NOT_PAUSED;
  }
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
      detail: `The operating system "${input.os.slice(0, 40)}" is not supported. This release backs up Linux, macOS and Windows (amd64) machines.`,
      extensions: { supported: [...SUPPORTED_ENDPOINT_OS] },
    });
  }
  if (!isSupportedEndpointTarget(input.os, input.arch)) {
    // Windows on ARM: restic ships no Windows arm64 build, and its shadow copy code refuses arm64.
    throw new ProblemError(422, "Operating system not supported", {
      type: UNSUPPORTED_OS_PROBLEM,
      detail:
        "Windows on ARM is not supported in this release. Restow backs up Windows on x64 (amd64) machines.",
      extensions: { supported: [...SUPPORTED_ENDPOINT_OS], os: input.os, arch: input.arch },
    });
  }
  const os = input.os;
  const tokenHash = hashSecret(input.token);
  const claimed = await claimEnrollmentToken(input.token, now);
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

  // A rebind token (docs/BAREMETAL.md 11): the existing machine gets a new secret, nothing is made.
  if (claimed.endpointId !== null) {
    return rotateEndpointSecret(
      claimed,
      input,
      { ip: context.ip, instanceUrl: context.instanceUrl, via: "enroll" },
      now,
    );
  }

  const tenantId = claimed.tenantId;
  const endpointId = randomUUID();
  const secret = generateAgentSecret();
  const repositoryPassword = randomBytes(32).toString("base64url");
  let secretId: string | null = null;
  let endpointCreated = false;
  /** The target `restic init` and the password file went to: the one a failure cleans up. */
  let initBackend: StorageBackend | null = null;
  try {
    const [tenant] = await providerDb
      .select({ status: tenants.status, timeZone: tenants.timeZone })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (tenant?.status !== "active") {
      throw new ProblemError(403, "Tenant suspended", {
        detail: "The tenant of this enrollment token is currently suspended.",
      });
    }
    // A machine added as a client that runs services (a container, a VM without a desktop) gets
    // the server profile: its defaults include where applications keep their data (#59).
    const { profile, reason } = enrollmentProfile(claimed.profile, os, input.machine);
    const facts = agentFactsOf(input, now, os);
    // No schedule until an admin puts the machine into a backup job (docs/AGENT.md, "Jobs"); the
    // profile's folders stay in the configuration for the job editor to start from.
    const config = enrolledEndpointConfig(os, profile, {
      timeZone: tenant.timeZone ?? DEFAULT_SCHEDULE_TIMEZONE,
    });
    const stored = await storeSecret(db, {
      tenantId,
      kind: REPOSITORY_SECRET_KIND,
      plaintext: repositoryPassword,
    });
    secretId = stored.id;
    await withTenantTx(db, tenantId, async (tx) => {
      // The lock every change of the primary takes (docs/STORAGE.md, "Runs and storage
      // changes"): a promotion, "keep" or "move" either committed before this (the target
      // resolved below is the new primary) or sees this active machine and refuses. Without it a
      // switch could commit between the two, and `restic init` would go to the old primary while
      // the agent writes everything else to the new one.
      await lockTenantStorage(tx, tenantId);
      await tx.insert(endpoints).values({
        id: endpointId,
        tenantId,
        hostname: input.hostname,
        displayName: claimed.displayName,
        os,
        arch: input.arch,
        profile,
        agentVersion: input.agentVersion,
        osVersion: input.osVersion,
        secretHash: secret.hash,
        repositorySecretId: stored.id,
        config,
        configVersion: 1,
        settings: {
          ...(facts ? { agent: facts } : {}),
          ...(reason
            ? {
                profileDetection: {
                  requested: claimed.profile,
                  reason,
                  technology: input.machine?.technology ?? "",
                },
              }
            : {}),
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
    initBackend = access.storage;
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
        profile,
        ...(reason ? { requestedProfile: claimed.profile, profileReason: reason } : {}),
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
      config: configResponse(config, 1, undefined, {
        os: input.os,
        baremetalPreview: appConfig.baremetalPreview,
      }),
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
      // Where init wrote, not whatever is the primary by now.
      const backend =
        initBackend ?? (await tenantStorage(db, tenantId).catch(() => null))?.storage ?? null;
      if (backend) {
        // Only the repository this request began under its fresh endpoint id goes: an own_scope
        // pass, held neither by restore mode nor by a target that cannot be compared
        // (storage/deletion-guard.ts). A guard that cannot read the restore mode leaves it; the
        // token is released all the same.
        await withDeletionPermit({ pass: "enrollment_cleanup", tenantId }, () =>
          removeRepositoryObjects(backend, `endpoints/${endpointId}/`),
        ).catch(() => undefined);
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
  const startsPaused = await agentStartsPaused();
  return withTenantTx(db, agent.tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, agent);
    const windows = endpoint.config.bandwidthWindows;
    const zone =
      (windows && windows.length > 0) || endpoint.config.policy?.backupWindow
        ? await bandwidthZoneOf(tx, agent.tenantId, endpoint.config)
        : null;
    return configResponse(
      endpoint.config,
      endpoint.configVersion,
      zone === null ? undefined : { zone, now },
      { startsPaused, os: endpoint.os, baremetalPreview: appConfig.baremetalPreview },
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
 * What an agent reports about the machine, written to `settings.agent`; null
 * for an agent that reports nothing (an earlier pre-release agent). The data
 * folders are kept as far as they are on the list of the machine's system.
 */
export function agentFactsOf(
  input: Pick<HeartbeatInput, "hooks" | "hookScripts" | "machine" | "dataFolders"> & {
    capabilities?: string[] | undefined;
  },
  now: Date,
  os: string,
): EndpointAgentFacts | null {
  const dataFolders = cleanDataFolderReport(os, input.dataFolders);
  if (!input.hooks && !input.machine && dataFolders === null && !input.capabilities) {
    return null;
  }
  // The Windows facts are Windows only (W1): another system never keeps them.
  const machine =
    input.machine && os !== "windows" && "windows" in input.machine
      ? (({ windows: _windows, ...rest }) => rest)(input.machine)
      : input.machine;
  return {
    ...(input.hooks ? { hooks: input.hooks } : {}),
    ...(input.hooks === "scripts" ? { hookScripts: input.hookScripts ?? [] } : {}),
    ...(machine ? { machine } : {}),
    ...(dataFolders !== null ? { dataFolders } : {}),
    // What the agent can do beyond the base contract (0.5.0: `sql_native_v1`, W2a).
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    reportedAt: now.toISOString(),
  };
}

/** How long unchanged facts are kept before a heartbeat writes them again (for `reportedAt`). */
export const AGENT_FACTS_REFRESH_MS = 60 * 60 * 1000;

/**
 * `settings` with the agent's facts in `settings.agent`, written only when they changed
 * (`reportedAt` aside) or were last written {@link AGENT_FACTS_REFRESH_MS} ago: otherwise the
 * column keeps its value, so a heartbeat every minute does not rewrite the machine's settings.
 */
function settingsWithFacts(facts: EndpointAgentFacts, now: Date): SQL {
  const json = JSON.stringify(facts);
  const staleBefore = new Date(now.getTime() - AGENT_FACTS_REFRESH_MS).toISOString();
  const stored = sql`${endpoints.settings}->'agent'`;
  return sql`CASE
    WHEN (${stored}) - 'reportedAt' IS DISTINCT FROM ${json}::jsonb - 'reportedAt'
      OR coalesce((${stored}->>'reportedAt') < ${staleBefore}, true)
    THEN jsonb_set(${endpoints.settings}, '{agent}', ${json}::jsonb)
    ELSE ${endpoints.settings} END`;
}

/** Record a heartbeat and hand out what is waiting for the agent. */
export async function heartbeat(
  agent: AgentContext,
  input: HeartbeatInput,
  now: Date = new Date(),
): Promise<{
  tasks: AgentTask[];
  startsPaused: boolean;
  cancel: AgentCancelOrders;
  updateNow: boolean;
}> {
  // While an update pauses new runs (#46) no backup request is handed out: it waits as a pending
  // task and goes out with the first heartbeat after the pause (like the tasks of a PVE node).
  // The answer says so, and an agent from 0.4.0 also holds back its scheduled backups.
  const pause = await agentStartPause();
  const startsPaused = pause.paused;
  // Restore mode: tasks from the restored dump are never handed out (restore-mode/hold.ts).
  const holdBefore = await restoreModeTaskHoldBefore();
  const answer = await withTenantTx(db, agent.tenantId, async (tx) => {
    const nextRunAt = input.nextRunAt ? new Date(input.nextRunAt) : null;
    const facts = agentFactsOf(input, now, agent.os);
    const [endpoint] = await tx
      .update(endpoints)
      .set({
        agentVersion: input.agentVersion,
        osVersion: input.osVersion,
        agentState: input.state,
        nextRunAt: nextRunAt && !Number.isNaN(nextRunAt.getTime()) ? nextRunAt : null,
        // Left out by an agent before 0.4.0: unknown, not "nothing waits".
        agentWaiting: input.waiting ?? null,
        agentConfigVersion: input.configVersion ?? null,
        lastSeenAt: now,
        ...(agent.profile === "server" ? { staleAlertedAt: null } : {}),
        // Only the agent's own facts change; the settings an admin made stay as they are.
        ...(facts ? { settings: settingsWithFacts(facts, now) } : {}),
      })
      .where(and(eq(endpoints.id, agent.endpointId), eq(endpoints.tenantId, agent.tenantId)))
      .returning();
    if (!endpoint) {
      throw new ProblemError(404, "Endpoint not found");
    }
    // The SQL inventory (W2a): only a Windows agent sends one, at most every 6 hours or after an
    // `sql_inventory` task.
    if (input.sqlInventory !== undefined && agent.os === "windows") {
      await recordSqlInventory(tx, agent, input.sqlInventory, now);
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

    if (holdBefore) {
      // A task from before the restore, waiting or delivered without a run: a restore, an
      // uninstall or a backup the agent may have done already in the timeline the database lost.
      await tx
        .update(endpointTasks)
        .set({
          status: "cancelled",
          finishedAt: now,
          errorMessage: RESTORE_MODE_TASK_HOLD_MESSAGE,
        })
        .where(
          and(
            eq(endpointTasks.endpointId, agent.endpointId),
            lt(endpointTasks.createdAt, holdBefore),
            or(
              eq(endpointTasks.status, "pending"),
              and(
                eq(endpointTasks.status, "delivered"),
                sql`NOT EXISTS (SELECT 1 FROM ${endpointRuns} r WHERE r.task_id = ${endpointTasks.id})`,
              ),
            ),
          ),
        );
    }

    const redeliverBefore = new Date(now.getTime() - REDELIVER_AFTER_MS);
    const waiting = await tx
      .select()
      .from(endpointTasks)
      .where(
        and(
          eq(endpointTasks.endpointId, agent.endpointId),
          // A check of the SQL backups (W2a) restores a database and runs CHECKDB: it waits too.
          startsPaused ? notInArray(endpointTasks.kind, ["backup_now", "sql_verify"]) : undefined,
          or(
            and(
              eq(endpointTasks.status, "pending"),
              // A restore test offered again waits for its time (ISO-8601 in UTC, compared as text).
              sql`coalesce(${endpointTasks.params} ->> 'notBefore', '') COLLATE "C" <= ${now.toISOString()}::text`,
            ),
            and(
              eq(endpointTasks.status, "delivered"),
              lt(endpointTasks.deliveredAt, redeliverBefore),
              // A delivered task with a cancel request is not handed out again.
              isNull(endpointTasks.cancelRequestedAt),
              sql`NOT EXISTS (SELECT 1 FROM ${endpointRuns} r WHERE r.task_id = ${endpointTasks.id})`,
            ),
          ),
        ),
      )
      .orderBy(asc(endpointTasks.createdAt))
      .limit(MAX_TASKS_PER_HEARTBEAT);

    const tasks: AgentTask[] = [];
    const finishedOnDelivery = waiting
      // `sql_inventory` (W2a) has no run: the agent answers with its next heartbeat.
      .filter(
        (task) =>
          task.kind === "update_config" ||
          task.kind === "uninstall" ||
          task.kind === "sql_inventory",
      )
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
    // What the agent is to stop (agents from 0.4.2; an older one ignores the field).
    const cancel = await agentCancelOrders(tx, agent.endpointId);
    return { tasks, startsPaused, cancel, updateRequestedAt: endpoint.updateRequestedAt };
  });
  const { updateRequestedAt, ...rest } = answer;
  return { ...rest, updateNow: await agentUpdateNow(agent, input, updateRequestedAt, pause) };
}

/**
 * "Update now" (0.4.2): an admin asked for it on the machine's page, or the server was just
 * updated and its nodes and agents follow (features/updates/fleet.ts). The agent then looks for
 * its update at once (`GET /agent/v1/update`, which still honours a paused tenant or machine)
 * and installs it when idle. A request is cleared once the agent runs the announced version.
 */
async function agentUpdateNow(
  agent: AgentContext,
  input: HeartbeatInput,
  requestedAt: Date | null,
  pause: JobStartPauseState,
): Promise<boolean> {
  if (requestedAt === null && pause.phase !== "fleet") {
    return false;
  }
  const announced = await announcedAgentVersion();
  const current = input.agentVersion;
  const behind =
    isAgentVersion(current) &&
    !current.includes("-dev") &&
    compareAgentVersions(announced, current) > 0;
  if (!behind && requestedAt !== null) {
    await withTenantTx(db, agent.tenantId, (tx) =>
      tx
        .update(endpoints)
        .set({ updateRequestedAt: null })
        .where(eq(endpoints.id, agent.endpointId)),
    );
  }
  return behind;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** The task a run of each kind may belong to; a `sql` run (W2a) never belongs to one. */
const TASK_KIND_OF_RUN: Readonly<Record<StartRunInput["kind"], AgentTask["kind"] | null>> = {
  backup: "backup_now",
  restore: "restore",
  verify_sample: "verify_sample",
  sql: null,
  sql_restore: "sql_restore",
  sql_verify: "sql_verify",
};

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
  const started = await withTenantTx(db, agent.tenantId, async (tx) => {
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
      if (TASK_KIND_OF_RUN[input.kind] === null || task.kind !== TASK_KIND_OF_RUN[input.kind]) {
        throw new ProblemError(409, "Task does not match the run", {
          detail: `A ${task.kind} task cannot start a ${input.kind} run.`,
        });
      }
      if (task.status !== "pending" && task.status !== "delivered") {
        throw new ProblemError(409, "Task already finished");
      }
      // Withdrawn in the UI after the agent got it: it ends here, no run starts.
      if (task.cancelRequestedAt) {
        await tx
          .update(endpointTasks)
          .set({ status: "cancelled", finishedAt: now })
          .where(eq(endpointTasks.id, task.id));
        return null;
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
  if (!started) {
    throw new ProblemError(409, "Task already finished", {
      detail: "This backup was cancelled in Restow.",
    });
  }
  return started;
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

/**
 * The run's statistics with the agent's activity report (docs/RANSOMWARE.md) beside them, checked
 * and bounded; a report without statistics (a failed run) is not kept. The consistency report
 * (whether a file system snapshot was used, agents from 0.5.0) is kept for a failed run too: the
 * snapshot may be why it failed.
 */
export function statsWithActivity(
  stats: FinishRunInput["stats"],
  activity: unknown,
  consistency?: unknown,
): EndpointRunStats | null {
  const snapshot = parseRunConsistency(consistency);
  if (!stats) {
    return snapshot ? { consistency: snapshot } : null;
  }
  const report = parseActivityReport(activity);
  return {
    ...stats,
    ...(report ? { activity: { ...report } } : {}),
    ...(snapshot ? { consistency: snapshot } : {}),
  };
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
    // A run that failed after a stop was asked for in the UI was stopped as asked.
    const cancelled = input.status === "failed" && run.cancelRequestedAt !== null;
    const status: EndpointRun["status"] = cancelled ? "cancelled" : input.status;
    // The layout of a whole machine backup: stored before the run's errors are, so a refused one
    // adds its hint to them.
    const layoutId = await storeRunLayout(tx, agent, run, input, errors);
    // A backup the size and space guard held (#99) says so, not the refusal restic reported. A
    // held run made no restore point, so it failed; a `partial` run made one and keeps its
    // own explanation.
    const held =
      !cancelled && input.status === "failed" && run.kind === "backup"
        ? await runSizeHoldOfRun(tx, "endpoint", agent.endpointId, run.id, run.startedAt)
        : null;
    const failure = held
      ? toFailureRecord(buildCause("storage.run_held", {}, { holdId: held.id }), { now })
      : cancelled
        ? null
        : failureRecordOf(input.status, errors, now);
    // The native SQL Server backup (W2a): its databases, backups and check reports.
    const sqlStats =
      run.kind === "sql"
        ? await recordSqlBackupRun(tx, agent, run, input, now)
        : // A check stopped in the UI states nothing about the backups: no report.
          run.kind === "sql_verify" && !cancelled
          ? await recordSqlVerifyRun(tx, agent, run, input, now)
          : run.kind === "sql_restore"
            ? await recordSqlRestoreRun(tx, agent, run, input, errors)
            : undefined;
    // A restore whose task read the repository from another target than the primary (a copy
    // target's repository copy, docs/STORAGE.md "Restoring from a copy") says so on its run.
    const readFrom =
      run.kind === "restore" && run.taskId
        ? readFromIn(
            (
              await tx
                .select({ params: endpointTasks.params })
                .from(endpointTasks)
                .where(eq(endpointTasks.id, run.taskId))
                .limit(1)
            )[0]?.params.readFrom,
          )
        : null;
    await tx
      .update(endpointRuns)
      .set({
        status,
        layoutId,
        finishedAt: finishedAt.getTime() < run.startedAt.getTime() ? now : finishedAt,
        snapshotId: input.snapshotId ?? null,
        stats: {
          ...withSqlStats(statsWithActivity(input.stats, input.activity, input.consistency), {
            sql: sqlStats,
            notices: runNoticesOf(input),
          }),
          ...(readFrom ? { readFrom } : {}),
        },
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

    // An agent that was restarted mid-run picks the work up again: that is not an outcome, and
    // neither is a run stopped on request.
    const interrupted = cancelled || (input.status === "failed" && isInterruptedOnly(errors));

    if (run.kind === "backup") {
      const good = input.status !== "failed" && input.snapshotId !== undefined;
      // The first good backup after a rebind is the new baseline of the ransomware signals
      // (docs/BAREMETAL.md 11, docs/RANSOMWARE.md): nothing before it is compared with it.
      if (good && endpoint.settings.activityBaselinePending) {
        await tx
          .update(endpointRuns)
          .set({ activityBaseline: true })
          .where(eq(endpointRuns.id, runId));
        const { activityBaselinePending: _cleared, ...settings } = endpoint.settings;
        await tx.update(endpoints).set({ settings }).where(eq(endpoints.id, agent.endpointId));
      }
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
      // A whole machine backup gets its layout checked (bare metal stage 1) right away.
      if (good && layoutId) {
        await queueBaremetalCheck(tx, agent, runId);
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

    // A machine that backs up only its databases (no folders, W2a): its `sql` runs are its
    // backups, so they keep it from going stale. Otherwise the file backup decides, and a
    // failing one is not hidden by working SQL runs.
    if (run.kind === "sql" && !interrupted && endpoint.config.paths.length === 0) {
      const good = input.status !== "failed" && input.snapshotId !== undefined;
      await tx
        .update(endpoints)
        .set({
          lastBackupAt: finishedAt,
          ...(good ? { lastSuccessAt: finishedAt, staleAlertedAt: null } : {}),
        })
        .where(eq(endpoints.id, agent.endpointId));
    }

    if (run.kind === "restore") {
      await auditEndpoint(tx, {
        tenantId: agent.tenantId,
        actor: agentActor(agent.hostname, agent.ip),
        action: ENDPOINT_AUDIT_ACTIONS.restoreFinished,
        endpointId: agent.endpointId,
        details: {
          runId,
          status: input.status,
          taskId: run.taskId,
          errors: errors.length,
          ...(readFrom ? { readFrom } : {}),
        },
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
          status: cancelled ? "cancelled" : input.status === "failed" ? "failed" : "done",
          finishedAt: now,
          errorMessage:
            input.status === "failed" ? (errors[0]?.message ?? "failed").slice(0, 500) : null,
        })
        .where(eq(endpointTasks.id, run.taskId));
    }

    // Likewise a SQL check that came to no result for any database (no space, a time limit).
    const incompleteSqlCheck =
      run.kind === "sql_verify" &&
      (sqlStats?.databases ?? []).every((database) => database.outcome === "incomplete");

    if (input.status === "failed" && !interrupted && !incompleteTest && !incompleteSqlCheck) {
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
    return { runId, status };
  });
}

/**
 * Hand stage 1 of the bare metal check (docs/BAREMETAL.md 12.1) to the worker for the run that
 * just recorded a layout. In a savepoint: a queue that is not there yet (the worker has not
 * started) must not fail the finish, and nor may anything else pg-boss refuses; the scheduler
 * catches the check up within the hour.
 */
async function queueBaremetalCheck(tx: Transaction, agent: AgentContext, runId: string) {
  const payload: EndpointJobPayload = {
    tenantId: agent.tenantId,
    endpointId: agent.endpointId,
    runId,
  };
  try {
    await tx.transaction(async (savepoint) => {
      await jobQueue(db).send(ENDPOINT_QUEUES.baremetalCheck, payload, {
        singletonKey: endpointSingletonKey(ENDPOINT_QUEUES.baremetalCheck, agent.endpointId),
        db: pgBossExecutor(savepoint),
      });
    });
  } catch {
    // The queue is not there yet (isMissingQueueSchema) or pg-boss refused: the run stands.
  }
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
