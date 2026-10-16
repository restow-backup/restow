import {
  AGENT_POLICY_KEYS,
  type AgentPolicyIssue,
  type AgentPolicyKey,
  type AgentPolicySettings,
  type AgentPolicyValues,
  agentPolicyIssues,
  cleanAgentPolicySettings,
  DEFAULT_AGENT_POLICY,
  EMPTY_GLOBAL_AGENT_POLICY,
  endpointPolicyFor,
  type GlobalAgentPolicy,
  type JobAgentPolicy,
  type MachineAgentPolicy,
  machineAgentPolicy,
  type PolicyLevels,
  type ResolvedAgentPolicy,
  resolveAgentPolicy,
  sameEndpointConfig,
  withEndpointPolicy,
} from "@restow/core";
import {
  backupJobMembers,
  backupJobs,
  type Database,
  endpoints,
  endpointTasks,
  settings,
  tenants,
} from "@restow/db";
import { and, eq, ne } from "drizzle-orm";
import { db, providerDb } from "../../db.js";
import { audit } from "../../lib/audit.js";
import { type DbExecutor, type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { auditEndpoint, ENDPOINT_AUDIT_ACTIONS, type EndpointActor } from "./audit.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";

/**
 * Agent policies (docs/AGENT.md, "Richtlinien"): the installation's policy with its locks
 * (`settings.agent_policy`, provider administrators), each tenant's level (`tenants.agent_policy`,
 * tenant administrators) and a backup job's level (`settings.policy` of the job, written by the
 * job editor). The effective policy of every machine is written into its configuration
 * (`endpoints.config.policy`), so a change raises the machine's configuration version and the
 * agent fetches it, exactly like a change of its job; the levels themselves never reach an agent.
 */

export const AGENT_POLICY_AUDIT_ACTIONS = {
  globalUpdated: "settings.agent_policy.updated",
  tenantUpdated: "tenant.agent_policy.updated",
} as const;

/** The installation's level as stored, with every field present. */
export function globalPolicyOf(stored: unknown): GlobalAgentPolicy {
  const value = (stored ?? {}) as { settings?: AgentPolicySettings; locks?: unknown };
  const locks = Array.isArray(value.locks)
    ? (value.locks.filter((key) =>
        (AGENT_POLICY_KEYS as readonly unknown[]).includes(key),
      ) as AgentPolicyKey[])
    : [];
  return { settings: cleanAgentPolicySettings(value.settings ?? {}), locks };
}

/** The installation's policy (installation pool; `{}` before the setup finished). */
export async function readGlobalAgentPolicy(
  database: DbExecutor = providerDb,
): Promise<GlobalAgentPolicy> {
  const [row] = await database.select({ value: settings.agentPolicy }).from(settings).limit(1);
  return row ? globalPolicyOf(row.value) : EMPTY_GLOBAL_AGENT_POLICY;
}

async function readTenantLevel(tx: Transaction, tenantId: string): Promise<AgentPolicySettings> {
  const [row] = await tx
    .select({ value: tenants.agentPolicy })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return cleanAgentPolicySettings(row?.value ?? {});
}

/** The levels above a job, for a tenant's transaction. */
export async function policyLevelsOf(tx: Transaction, tenantId: string): Promise<PolicyLevels> {
  return { global: await readGlobalAgentPolicy(), tenant: await readTenantLevel(tx, tenantId) };
}

function invalidProblem(issues: readonly AgentPolicyIssue[]): ProblemError {
  const first = issues[0];
  return new ProblemError(422, "Invalid agent policy", {
    type: ENDPOINT_PROBLEMS.invalidAgentPolicy,
    detail: `The setting ${first?.key ?? "?"} cannot be saved as sent (${first?.code ?? "invalid"}).`,
    extensions: { issues },
  });
}

/** 409 when a level below the installation sets what the installation locked. */
export function assertNotLocked(
  level: Record<string, unknown> | null | undefined,
  global: GlobalAgentPolicy,
): void {
  const keys = global.locks.filter((key) => level?.[key] !== undefined);
  if (keys.length > 0) {
    throw new ProblemError(409, "Locked by the installation", {
      type: ENDPOINT_PROBLEMS.agentPolicyLocked,
      detail: `The installation's agent policy locks ${keys.join(", ")}; it cannot be changed here.`,
      extensions: { keys },
    });
  }
}

/** Validates one level (422 with the issues), returns it cleaned. */
export function validatedLevel<T extends AgentPolicySettings>(
  input: Record<string, unknown>,
  allowed: readonly AgentPolicyKey[] = AGENT_POLICY_KEYS,
): T {
  const issues = agentPolicyIssues(input, allowed);
  if (issues.length > 0) {
    throw invalidProblem(issues);
  }
  return cleanAgentPolicySettings(input as T);
}

// ---------------------------------------------------------------------------
// Writing the effective policy into the machines' configurations
// ---------------------------------------------------------------------------

export interface PolicyApplyResult {
  /** Machines whose configuration changed (and got a new version). */
  readonly updated: number;
}

/**
 * Write every machine's effective policy into its configuration, for the levels given: a machine
 * whose policy did not change is left alone, version included; one that changed gets a new
 * version, an `update_config` task and `endpoint.config.changed` in the audit log (changed:
 * `config.policy`, `via.policy` naming the level that changed).
 */
export async function applyAgentPolicies(
  tx: Transaction,
  tenantId: string,
  levels: PolicyLevels,
  options: { actor: EndpointActor; now: Date; via: "global" | "tenant" },
): Promise<PolicyApplyResult> {
  const rows = await tx
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), ne(endpoints.status, "revoked")))
    .for("update");
  if (rows.length === 0) {
    return { updated: 0 };
  }
  const memberships = await tx
    .select({ endpointId: backupJobMembers.endpointId, settings: backupJobs.settings })
    .from(backupJobMembers)
    .innerJoin(backupJobs, eq(backupJobs.id, backupJobMembers.jobId))
    .where(and(eq(backupJobMembers.tenantId, tenantId), eq(backupJobs.kind, "endpoint")));
  const jobPolicy = new Map<string, JobAgentPolicy | undefined>();
  for (const member of memberships) {
    if (member.endpointId) {
      jobPolicy.set(member.endpointId, member.settings?.policy);
    }
  }
  let updated = 0;
  for (const endpoint of rows) {
    const next = withEndpointPolicy(
      endpoint.config,
      endpointPolicyFor(levels, jobPolicy.get(endpoint.id)),
    );
    if (sameEndpointConfig(endpoint.config, next)) {
      continue;
    }
    const configVersion = endpoint.configVersion + 1;
    await tx
      .update(endpoints)
      .set({ config: next, configVersion })
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
        changed: ["config.policy"],
        policy: next.policy ?? null,
        via: { policy: options.via },
      },
    });
    updated++;
  }
  return { updated };
}

// ---------------------------------------------------------------------------
// The installation's level
// ---------------------------------------------------------------------------

export interface GlobalAgentPolicyDto {
  settings: AgentPolicySettings;
  locks: AgentPolicyKey[];
  defaults: AgentPolicyValues;
  effective: ResolvedAgentPolicy;
}

export interface AgentPolicyChangeDto {
  /** Machines whose configuration changed with this save. */
  machinesUpdated: number;
}

function globalDto(policy: GlobalAgentPolicy): GlobalAgentPolicyDto {
  return {
    settings: policy.settings,
    locks: policy.locks,
    defaults: DEFAULT_AGENT_POLICY,
    effective: resolveAgentPolicy(policy, null, null),
  };
}

export async function getGlobalAgentPolicy(
  database: DbExecutor = providerDb,
): Promise<GlobalAgentPolicyDto> {
  return globalDto(await readGlobalAgentPolicy(database));
}

/**
 * Replace the installation's policy (what is left out inherits the default) and write the result
 * into the configuration of every machine of every tenant. Audited in the installation's chain
 * with the policy before and after.
 */
export async function updateGlobalAgentPolicy(
  input: { settings: Record<string, unknown>; locks: AgentPolicyKey[] },
  actor: { id: string; email: string; ip: string | null },
  options: { tenantDb?: Database; now?: Date } = {},
): Promise<GlobalAgentPolicyDto & AgentPolicyChangeDto> {
  const now = options.now ?? new Date();
  const next: GlobalAgentPolicy = {
    settings: validatedLevel(input.settings),
    locks: AGENT_POLICY_KEYS.filter((key) => input.locks.includes(key)),
  };
  await providerDb.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).limit(1).for("update");
    if (!row) {
      throw new ProblemError(409, "Setup not completed", {
        type: "urn:restow:problem:setup-incomplete",
        detail: "Finish the setup wizard before changing installation settings.",
      });
    }
    await tx.update(settings).set({ agentPolicy: next }).where(eq(settings.id, row.id));
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: AGENT_POLICY_AUDIT_ACTIONS.globalUpdated,
      target: row.id,
      targetType: "settings",
      ip: actor.ip,
      details: { before: globalPolicyOf(row.agentPolicy), after: next },
    });
  });
  // Every tenant's machines, each tenant in its own pinned transaction.
  const tenantRows = await providerDb.select({ id: tenants.id }).from(tenants);
  let machinesUpdated = 0;
  const endpointActor: EndpointActor = { label: actor.email, userId: actor.id, ip: actor.ip };
  for (const tenant of tenantRows) {
    machinesUpdated += await withTenantTx(options.tenantDb ?? db, tenant.id, async (tx) => {
      const levels = { global: next, tenant: await readTenantLevel(tx, tenant.id) };
      const result = await applyAgentPolicies(tx, tenant.id, levels, {
        actor: endpointActor,
        now,
        via: "global",
      });
      return result.updated;
    });
  }
  return { ...globalDto(next), machinesUpdated };
}

// ---------------------------------------------------------------------------
// A tenant's level
// ---------------------------------------------------------------------------

export interface TenantAgentPolicyDto {
  /** The installation's level, which the tenant inherits from (and its locks). */
  global: { settings: AgentPolicySettings; locks: AgentPolicyKey[] };
  /** The tenant's own settings. */
  settings: AgentPolicySettings;
  defaults: AgentPolicyValues;
  /** What the tenant's machines get without a job of their own (a job may override). */
  effective: ResolvedAgentPolicy;
}

function tenantDto(global: GlobalAgentPolicy, level: AgentPolicySettings): TenantAgentPolicyDto {
  return {
    global: { settings: global.settings, locks: global.locks },
    settings: level,
    defaults: DEFAULT_AGENT_POLICY,
    effective: resolveAgentPolicy(global, level, null),
  };
}

export async function getTenantAgentPolicy(
  database: Database,
  tenantId: string,
): Promise<TenantAgentPolicyDto> {
  const global = await readGlobalAgentPolicy();
  return withTenantTx(database, tenantId, async (tx) =>
    tenantDto(global, await readTenantLevel(tx, tenantId)),
  );
}

/**
 * Replace the tenant's level (what is left out inherits), refused for a setting the installation
 * locked, and write the result into every machine of the tenant. Audited in the tenant's chain.
 */
export async function updateTenantAgentPolicy(
  database: Database,
  tenantId: string,
  input: Record<string, unknown>,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<TenantAgentPolicyDto & AgentPolicyChangeDto> {
  const level = validatedLevel(input);
  const global = await readGlobalAgentPolicy();
  assertNotLocked(level, global);
  return withTenantTx(database, tenantId, async (tx) => {
    const before = await readTenantLevel(tx, tenantId);
    await tx.update(tenants).set({ agentPolicy: level }).where(eq(tenants.id, tenantId));
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      ip: actor.ip,
      action: AGENT_POLICY_AUDIT_ACTIONS.tenantUpdated,
      target: tenantId,
      targetType: "tenant",
      details: { before, after: level },
    });
    const { updated } = await applyAgentPolicies(
      tx,
      tenantId,
      { global, tenant: level },
      { actor, now, via: "tenant" },
    );
    return { ...tenantDto(global, level), machinesUpdated: updated };
  });
}

// ---------------------------------------------------------------------------
// One machine
// ---------------------------------------------------------------------------

export interface EndpointAgentPolicyDto {
  /** The backup job whose level applies; null for a machine in no job. */
  job: { id: string; name: string } | null;
  /** Every setting as it applies to this machine, with where it comes from. */
  effective: MachineAgentPolicy;
  /** The time windows of the job's (or the machine's) upload limit apply as well. */
  bandwidthWindows: boolean;
  defaults: AgentPolicyValues;
}

/**
 * The agent policy as it applies to one machine (the machine's page, read-only for everybody who
 * may open the machine): the installation's, the tenant's and the job's level, the job's own
 * upload limit and the machine's AC power switch, each with its source and whether it is locked.
 */
export async function getEndpointAgentPolicy(
  database: Database,
  tenantId: string,
  endpointId: string,
): Promise<EndpointAgentPolicyDto> {
  const global = await readGlobalAgentPolicy();
  return withTenantTx(database, tenantId, async (tx) => {
    const [endpoint] = await tx
      .select({ config: endpoints.config })
      .from(endpoints)
      .where(and(eq(endpoints.id, endpointId), eq(endpoints.tenantId, tenantId)))
      .limit(1);
    if (!endpoint) {
      throw new ProblemError(404, "Endpoint not found");
    }
    const [membership] = await tx
      .select({ id: backupJobs.id, name: backupJobs.name, settings: backupJobs.settings })
      .from(backupJobMembers)
      .innerJoin(backupJobs, eq(backupJobs.id, backupJobMembers.jobId))
      .where(
        and(
          eq(backupJobMembers.tenantId, tenantId),
          eq(backupJobMembers.endpointId, endpointId),
          eq(backupJobs.kind, "endpoint"),
        ),
      )
      .limit(1);
    const tenant = await readTenantLevel(tx, tenantId);
    const resolved = resolveAgentPolicy(global, tenant, membership?.settings?.policy ?? null);
    const config = endpoint.config;
    const view = machineAgentPolicy(
      resolved,
      {
        bandwidthKbps: config.bandwidthKbps ?? null,
        bandwidthWindows: config.bandwidthWindows?.length ?? 0,
        onlyOnAcPower: config.onlyOnAcPower === true,
      },
      membership !== undefined,
    );
    return {
      job: membership ? { id: membership.id, name: membership.name } : null,
      effective: view.effective,
      bandwidthWindows: view.bandwidthWindows,
      defaults: DEFAULT_AGENT_POLICY,
    };
  });
}
