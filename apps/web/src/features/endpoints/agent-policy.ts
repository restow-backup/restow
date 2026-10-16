import { apiFetch } from "@/lib/api";

/**
 * Agent policies (docs/AGENT.md, "Richtlinien"): when and how the agents of servers and clients
 * back up, on three levels. The installation sets the global policy and may lock any setting; a
 * tenant overrides what is not locked; a backup job overrides what is not locked for its machines.
 * The shapes follow `/api/v1/settings/agent-policy` and `/api/v1/endpoints/agent-policy` (the
 * server's @restow/core endpoints/agent-policy.ts, which the browser bundle does not import).
 */

export const AGENT_POLICY_KEYS = [
  "backupWindow",
  "catchUp",
  "bandwidthKbps",
  "onlyOnAcPower",
  "retries",
] as const;
export type AgentPolicyKey = (typeof AGENT_POLICY_KEYS)[number];

/** What a job may override: its upload limit is the job's own field. */
export const JOB_POLICY_KEYS = ["backupWindow", "catchUp", "onlyOnAcPower", "retries"] as const;
export type JobPolicyKey = (typeof JOB_POLICY_KEYS)[number];

export type CatchUpMode = "asap" | "next_window";

export interface BackupWindow {
  /** Days the window starts on: 1 = Monday ... 7 = Sunday. */
  days: number[];
  from: string;
  to: string;
}

export interface CatchUpPolicy {
  enabled: boolean;
  mode: CatchUpMode;
  /** null: any age. */
  maxAgeHours: number | null;
}

export interface AgentPolicyValues {
  backupWindow: BackupWindow | null;
  catchUp: CatchUpPolicy;
  bandwidthKbps: number | null;
  onlyOnAcPower: boolean;
  retries: number;
}

/** One level: a key that is present is set at this level. */
export type AgentPolicySettings = Partial<AgentPolicyValues>;

export type AgentPolicySource = "default" | "global" | "tenant" | "job";

export interface ResolvedSetting<T> {
  value: T;
  source: AgentPolicySource;
  locked: boolean;
}

export type ResolvedAgentPolicy = { [K in AgentPolicyKey]: ResolvedSetting<AgentPolicyValues[K]> };

export const MAX_RETRIES = 10;
export const MAX_CATCH_UP_AGE_HOURS = 24 * 30;
export const MAX_BANDWIDTH_KBPS = 10_000_000;

/** What the agents did before policies: the value of a setting no level sets. */
export const DEFAULT_AGENT_POLICY: AgentPolicyValues = {
  backupWindow: null,
  catchUp: { enabled: true, mode: "asap", maxAgeHours: null },
  bandwidthKbps: null,
  onlyOnAcPower: false,
  retries: 5,
};

export interface GlobalAgentPolicyView {
  settings: AgentPolicySettings;
  locks: AgentPolicyKey[];
  defaults: AgentPolicyValues;
  effective: ResolvedAgentPolicy;
}

export interface TenantAgentPolicyView {
  global: { settings: AgentPolicySettings; locks: AgentPolicyKey[] };
  settings: AgentPolicySettings;
  defaults: AgentPolicyValues;
  effective: ResolvedAgentPolicy;
}

export interface PolicyChange {
  /** Machines whose configuration changed with the save. */
  machinesUpdated: number;
}

/**
 * The value of every setting and where it comes from, with `level` on top of `above` (the result
 * of the levels above it): a locked setting keeps the value above, a key the level sets wins, else
 * the value above stays.
 */
export function resolveOnTop(
  above: ResolvedAgentPolicy,
  level: AgentPolicySettings,
  source: AgentPolicySource,
): ResolvedAgentPolicy {
  const result = { ...above } as Record<AgentPolicyKey, ResolvedSetting<unknown>>;
  for (const key of AGENT_POLICY_KEYS) {
    const value = level[key];
    if (!above[key].locked && value !== undefined) {
      result[key] = { value, source, locked: false };
    }
  }
  return result as ResolvedAgentPolicy;
}

/** A level with only the keys `allowed` lists and the keys that are not locked. */
export function cleanLevel<T extends AgentPolicySettings>(
  level: T,
  allowed: readonly AgentPolicyKey[],
  locks: readonly AgentPolicyKey[] = [],
): T {
  const clean: AgentPolicySettings = {};
  for (const key of allowed) {
    if (level[key] !== undefined && !locks.includes(key)) {
      (clean as Record<string, unknown>)[key] = level[key];
    }
  }
  return clean as T;
}

/** What a setting is when it is switched on at a level: the value above it as a start. */
export function startValue<K extends AgentPolicyKey>(
  key: K,
  above: ResolvedAgentPolicy | null,
): AgentPolicyValues[K] {
  const value = above?.[key].value ?? DEFAULT_AGENT_POLICY[key];
  if (key === "backupWindow" && value === null) {
    // Switching the window on starts from the usual night window.
    return { days: [1, 2, 3, 4, 5], from: "20:00", to: "06:00" } as AgentPolicyValues[K];
  }
  return value as AgentPolicyValues[K];
}

/** The problem of one setting's value, as a key of the `policy.problems` texts. */
export function policyValueProblem(key: AgentPolicyKey, value: unknown): string | null {
  switch (key) {
    case "backupWindow": {
      if (value === null) return null;
      const window = value as BackupWindow;
      if (window.days.length === 0) return "days";
      if (!/^\d{2}:\d{2}$/.test(window.from) || !/^\d{2}:\d{2}$/.test(window.to)) return "time";
      return null;
    }
    case "catchUp": {
      const age = (value as CatchUpPolicy).maxAgeHours;
      return age !== null && (!Number.isInteger(age) || age < 1 || age > MAX_CATCH_UP_AGE_HOURS)
        ? "maxAge"
        : null;
    }
    case "bandwidthKbps":
      return value !== null &&
        (!Number.isInteger(value) ||
          (value as number) < 1 ||
          (value as number) > MAX_BANDWIDTH_KBPS)
        ? "bandwidth"
        : null;
    case "retries":
      return !Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_RETRIES
        ? "retries"
        : null;
    default:
      return null;
  }
}

/** The first setting of a level whose value cannot be saved, or null. */
export function firstPolicyProblem(
  level: AgentPolicySettings,
): { key: AgentPolicyKey; problem: string } | null {
  for (const key of AGENT_POLICY_KEYS) {
    if (level[key] === undefined) continue;
    const problem = policyValueProblem(key, level[key]);
    if (problem) return { key, problem };
  }
  return null;
}

/** Where one machine's value comes from: a level of the policy, or the machine's own setting. */
export type MachinePolicySource = AgentPolicySource | "machine";

export type MachineAgentPolicy = {
  [K in AgentPolicyKey]: {
    value: AgentPolicyValues[K];
    source: MachinePolicySource;
    locked: boolean;
  };
};

/** `GET /api/v1/endpoints/:id/agent-policy`: what applies to one machine (read-only). */
export interface EndpointAgentPolicyView {
  job: { id: string; name: string } | null;
  effective: MachineAgentPolicy;
  /** The time windows of the job's (or the machine's) upload limit apply as well. */
  bandwidthWindows: boolean;
  defaults: AgentPolicyValues;
}

// --- Requests ---------------------------------------------------------------------

export const agentPolicyKeys = {
  global: ["installation", "agent-policy"] as const,
  tenant: (tenantId: string | null) => ["tenant", tenantId, "endpoints", "agent-policy"] as const,
  /** Under the machine's detail, so whatever refreshes the detail refreshes it too. */
  endpoint: (tenantId: string | null, endpointId: string) =>
    ["tenant", tenantId, "endpoints", "detail", endpointId, "agent-policy"] as const,
};

export function fetchGlobalAgentPolicy(): Promise<GlobalAgentPolicyView> {
  return apiFetch<GlobalAgentPolicyView>("/settings/agent-policy", { tenantId: null });
}

export function saveGlobalAgentPolicy(input: {
  settings: AgentPolicySettings;
  locks: AgentPolicyKey[];
}): Promise<GlobalAgentPolicyView & PolicyChange> {
  return apiFetch<GlobalAgentPolicyView & PolicyChange>("/settings/agent-policy", {
    method: "PUT",
    body: input,
    tenantId: null,
  });
}

export function fetchEndpointAgentPolicy(endpointId: string): Promise<EndpointAgentPolicyView> {
  return apiFetch<EndpointAgentPolicyView>(
    `/endpoints/${encodeURIComponent(endpointId)}/agent-policy`,
  );
}

export function fetchTenantAgentPolicy(): Promise<TenantAgentPolicyView> {
  return apiFetch<TenantAgentPolicyView>("/endpoints/agent-policy");
}

export function saveTenantAgentPolicy(
  settings: AgentPolicySettings,
): Promise<TenantAgentPolicyView & PolicyChange> {
  return apiFetch<TenantAgentPolicyView & PolicyChange>("/endpoints/agent-policy", {
    method: "PUT",
    body: settings,
  });
}

/** The defaults as the result of no level (the installation's view starts from them). */
export function resolvedDefaults(
  defaults: AgentPolicyValues = DEFAULT_AGENT_POLICY,
): ResolvedAgentPolicy {
  const result = {} as Record<AgentPolicyKey, ResolvedSetting<unknown>>;
  for (const key of AGENT_POLICY_KEYS) {
    result[key] = { value: defaults[key], source: "default", locked: false };
  }
  return result as ResolvedAgentPolicy;
}

/** What the tenant inherits: the installation's level on the defaults, with its locks. */
export function resolvedGlobal(view: TenantAgentPolicyView): ResolvedAgentPolicy {
  const above = resolveOnTop(resolvedDefaults(view.defaults), view.global.settings, "global");
  const result = above as Record<AgentPolicyKey, ResolvedSetting<unknown>>;
  for (const key of view.global.locks) {
    result[key] = { ...result[key], locked: true };
  }
  return above;
}
