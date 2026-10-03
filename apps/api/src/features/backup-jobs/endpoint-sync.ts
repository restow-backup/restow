import {
  buildEndpointConfig,
  effectiveSchedule,
  effectiveSettings,
  isUnscheduled,
  noSchedule,
  retentionToWrite,
  sameEndpointConfig,
} from "@restow/core";
import {
  type BackupJob,
  type Endpoint,
  type EndpointConfig,
  backupJobMembers,
  endpointRuns,
  endpointTasks,
  endpoints,
} from "@restow/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { ENDPOINT_AUDIT_ACTIONS, auditEndpoint } from "../endpoints/audit.js";
import { hookFingerprint } from "../endpoints/dto.js";
import { assertHooksAllowed, hookChangeNeedsRecentSignIn } from "../endpoints/service.js";
import { sameJson } from "./json.js";
import type { JobActor } from "./service-types.js";

/**
 * The one place that writes `endpoints.config` for a machine that belongs to a job
 * (docs/AGENT.md, "Jobs"). The configuration is the machine's own with the job's schedule and
 * settings, and the machine's override on top, written over it; `configVersion` goes up and the
 * agent is told to fetch it (an `update_config` task) exactly as when an administrator changed
 * the machine by hand, so the agent keeps reading `GET /agent/v1/config` and nothing else.
 * Writing is idempotent: a configuration that already is what the job asks for is left alone,
 * version included. The same function runs when a job or its scope changes and when the
 * migration turns the machines of an older installation into jobs. A machine that leaves its job
 * goes back to the schedule `none` ({@link releaseEndpointConfigs}): backups run only in a job.
 */

export interface SyncOptions {
  /** Only these machines; all members of the job when omitted. */
  readonly targetIds?: readonly string[];
  readonly actor: JobActor;
  readonly now: Date;
  /**
   * Called before anything is written when a hook was set or changed (it runs as root on the
   * machine); throws to refuse the whole change (the route passes the recent-sign-in check).
   */
  readonly confirmHookChange?: () => void;
}

export interface SyncedEndpoint {
  readonly endpointId: string;
  readonly hostname: string;
  readonly changed: readonly string[];
  readonly configVersion: number;
}

export interface SyncResult {
  readonly updated: readonly SyncedEndpoint[];
  /** Machines whose configuration already was what the job asks for. */
  readonly unchanged: number;
  /** Members that are revoked and take no configuration. */
  readonly skipped: number;
}

const CONFIG_KEYS = [
  "schedule",
  "paths",
  "excludes",
  "hooks",
  "bandwidthKbps",
  "bandwidthWindows",
  "excludeLargerThanBytes",
] as const;

function hooksOf(config: EndpointConfig): { pre?: string; post?: string } {
  const hooks: { pre?: string; post?: string } = {};
  if (config.hooks?.pre) hooks.pre = config.hooks.pre;
  if (config.hooks?.post) hooks.post = config.hooks.post;
  return hooks;
}

/** Which keys of the configuration differ (an empty hook is no hook). */
export function changedConfigKeys(current: EndpointConfig, next: EndpointConfig): string[] {
  const same = sameJson;
  const view = (config: EndpointConfig) => ({ ...config, hooks: hooksOf(config) });
  const a = view(current);
  const b = view(next);
  return CONFIG_KEYS.filter((key) => !same(a[key], b[key]));
}

/** The hook check of a machine, naming the machine in the refusal (a job spans many). */
function assertHooksForMachine(endpoint: Endpoint, hooks: { pre?: string; post?: string }): void {
  try {
    assertHooksAllowed(hooks, endpoint.settings);
  } catch (error) {
    if (error instanceof ProblemError) {
      const name = endpoint.displayName ?? endpoint.hostname;
      throw new ProblemError(error.status, error.title, {
        type: error.type,
        detail: `${name}: ${error.detail ?? error.title}`,
        extensions: {
          ...error.extensions,
          endpoint: { id: endpoint.id, hostname: endpoint.hostname },
        },
      });
    }
    throw error;
  }
}

interface Planned {
  readonly endpoint: Endpoint;
  readonly next: EndpointConfig;
  readonly changed: string[];
  readonly retention: ReturnType<typeof retentionToWrite>;
}

export async function syncEndpointConfigs(
  tx: Transaction,
  tenantId: string,
  job: Pick<BackupJob, "id" | "name" | "schedule" | "settings">,
  options: SyncOptions,
): Promise<SyncResult> {
  const filters = [eq(backupJobMembers.jobId, job.id), eq(backupJobMembers.tenantId, tenantId)];
  if (options.targetIds) {
    if (options.targetIds.length === 0) {
      return { updated: [], unchanged: 0, skipped: 0 };
    }
    filters.push(inArray(backupJobMembers.endpointId, [...options.targetIds]));
  }
  const members = await tx
    .select({ endpointId: backupJobMembers.endpointId, overrides: backupJobMembers.overrides })
    .from(backupJobMembers)
    .where(and(...filters));
  const ids = members.flatMap((member) => (member.endpointId ? [member.endpointId] : []));
  if (ids.length === 0) {
    return { updated: [], unchanged: 0, skipped: 0 };
  }
  // Locked: a change by hand to the same machine waits for this transaction.
  const rows = await tx
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), inArray(endpoints.id, ids)))
    .for("update");
  const byId = new Map(rows.map((row) => [row.id, row]));

  const planned: Planned[] = [];
  let unchanged = 0;
  let skipped = 0;
  let hookSet = false;
  for (const member of members) {
    const endpoint = member.endpointId ? byId.get(member.endpointId) : undefined;
    if (!endpoint || endpoint.status !== "active") {
      skipped++;
      continue;
    }
    const overrides = member.overrides ?? {};
    const settings = effectiveSettings(job.settings ?? {}, overrides);
    const next = buildEndpointConfig(
      endpoint.config,
      effectiveSchedule(job.schedule, overrides),
      settings,
    );
    const retention = retentionToWrite(settings.retention, endpoint.settings.retention);
    if (sameEndpointConfig(endpoint.config, next) && retention === null) {
      unchanged++;
      continue;
    }
    const changed = changedConfigKeys(endpoint.config, next);
    if (changed.includes("hooks")) {
      const hooks = hooksOf(next);
      assertHooksForMachine(endpoint, hooks);
      hookSet ||= hookChangeNeedsRecentSignIn(hooks);
    }
    planned.push({ endpoint, next, changed, retention });
  }
  if (hookSet) {
    options.confirmHookChange?.();
  }

  const updated: SyncedEndpoint[] = [];
  for (const { endpoint, next, changed, retention } of planned) {
    const configChanged = changed.length > 0;
    const set: Partial<typeof endpoints.$inferInsert> = {};
    const keys = changed.map((key) => `config.${key}`);
    if (configChanged) {
      set.config = next;
      set.configVersion = endpoint.configVersion + 1;
    }
    if (retention) {
      set.settings = { ...endpoint.settings, retention };
      keys.push("settings.retention");
    }
    await tx.update(endpoints).set(set).where(eq(endpoints.id, endpoint.id));
    if (set.configVersion !== undefined) {
      // Tell the agent to fetch it now instead of at its next scheduled look.
      await tx.insert(endpointTasks).values({
        tenantId,
        endpointId: endpoint.id,
        kind: "update_config",
        params: { configVersion: set.configVersion },
        createdBy: options.actor.userId,
        createdAt: options.now,
      });
    }
    await auditEndpoint(tx, {
      tenantId,
      actor: options.actor,
      action: ENDPOINT_AUDIT_ACTIONS.configChanged,
      endpointId: endpoint.id,
      details: {
        hostname: endpoint.hostname,
        changed: keys,
        via: { job: { id: job.id, name: job.name } },
        ...(changed.includes("hooks")
          ? {
              hooks: {
                pre: hookFingerprint(next.hooks.pre),
                post: hookFingerprint(next.hooks.post),
              },
            }
          : {}),
        ...(changed.includes("paths") ? { paths: next.paths } : {}),
        ...(changed.includes("schedule") ? { schedule: next.schedule } : {}),
      },
    });
    updated.push({
      endpointId: endpoint.id,
      hostname: endpoint.hostname,
      changed: keys,
      configVersion: set.configVersion ?? endpoint.configVersion,
    });
  }
  return { updated, unchanged, skipped };
}

/** Machines that left a job and went back to waiting for one. */
export interface ReleasedEndpoint {
  readonly endpointId: string;
  readonly hostname: string;
  readonly configVersion: number;
}

/**
 * Put machines that left `job` (taken out of it, or the job was deleted) back to the schedule
 * `none`, so they stop backing up until they are in a job again (release 0.2.1; before, a machine
 * kept the configuration last written to it). Only the schedule changes: the folders and the rest
 * stay for the next job to start from, and the server hands an agent none of them while the
 * schedule is `none` (`configResponse`). A backup request that has not started a run is
 * dropped; one already running ends as it would. Machines that are in another job by now (moved
 * into it in the same change) and revoked ones are left alone. Like `syncEndpointConfigs`, it
 * raises the configuration version and tells the agent to fetch it.
 */
export async function releaseEndpointConfigs(
  tx: Transaction,
  tenantId: string,
  job: Pick<BackupJob, "id" | "name">,
  endpointIds: readonly string[],
  options: { readonly actor: JobActor; readonly now: Date },
): Promise<ReleasedEndpoint[]> {
  if (endpointIds.length === 0) {
    return [];
  }
  const stillInJob = await tx
    .select({ endpointId: backupJobMembers.endpointId })
    .from(backupJobMembers)
    .where(
      and(
        eq(backupJobMembers.tenantId, tenantId),
        inArray(backupJobMembers.endpointId, [...endpointIds]),
      ),
    );
  const member = new Set(stillInJob.map((row) => row.endpointId));
  const ids = endpointIds.filter((id) => !member.has(id));
  if (ids.length === 0) {
    return [];
  }
  const rows = await tx
    .select()
    .from(endpoints)
    .where(
      and(
        eq(endpoints.tenantId, tenantId),
        inArray(endpoints.id, ids),
        ne(endpoints.status, "revoked"),
      ),
    )
    .for("update");
  const released: ReleasedEndpoint[] = [];
  for (const endpoint of rows) {
    await tx
      .update(endpointTasks)
      .set({
        status: "failed",
        finishedAt: options.now,
        errorMessage: "the machine left its backup job",
      })
      .where(
        and(
          eq(endpointTasks.endpointId, endpoint.id),
          eq(endpointTasks.kind, "backup_now"),
          inArray(endpointTasks.status, ["pending", "delivered"]),
          sql`NOT EXISTS (SELECT 1 FROM ${endpointRuns} r WHERE r.task_id = ${endpointTasks.id})`,
        ),
      );
    if (isUnscheduled(endpoint.config.schedule)) {
      continue;
    }
    const schedule = noSchedule(endpoint.config.schedule.timeZone);
    const configVersion = endpoint.configVersion + 1;
    await tx
      .update(endpoints)
      .set({ config: { ...endpoint.config, schedule }, configVersion })
      .where(eq(endpoints.id, endpoint.id));
    await tx.insert(endpointTasks).values({
      tenantId,
      endpointId: endpoint.id,
      kind: "update_config",
      params: { configVersion },
      createdBy: options.actor.userId,
      createdAt: options.now,
    });
    await auditEndpoint(tx, {
      tenantId,
      actor: options.actor,
      action: ENDPOINT_AUDIT_ACTIONS.configChanged,
      endpointId: endpoint.id,
      details: {
        hostname: endpoint.hostname,
        changed: ["config.schedule"],
        schedule,
        via: { job: { id: job.id, name: job.name }, left: true },
      },
    });
    released.push({ endpointId: endpoint.id, hostname: endpoint.hostname, configVersion });
  }
  return released;
}
