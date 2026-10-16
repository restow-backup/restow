/**
 * Agent policies (docs/AGENT.md, "Richtlinien"): when and how the agents of servers and clients
 * back up, on three levels. The installation (provider) sets the global policy and may lock any
 * of its settings; a tenant overrides what is not locked; a backup job overrides what is not
 * locked for its machines. A level sets a setting by carrying its key; a key it leaves out
 * inherits. Pure code, shared by the API (validation, the configuration it writes and serves) and
 * the web app (where a value comes from).
 *
 * Settings:
 *   - `backupWindow`: the days and hours in which scheduled backups, catch-ups and retries may
 *     start (a running backup is never stopped by it). `null`: always, the default.
 *   - `catchUp`: whether a backup missed while the machine was off or asleep is caught up, as soon
 *     as possible or in the next backup window, and up to which age. Default: at once, any age.
 *   - `bandwidthKbps`: the upload limit a job without its own limit uses; `null` = unlimited. A
 *     job that chooses "unlimited" (its limit `0`, {@link UNLIMITED_BANDWIDTH_KBPS}) does not use
 *     it; only a lock of the installation overrides that choice.
 *   - `onlyOnAcPower`: scheduled backups only on AC power.
 *   - `retries`: automatic retries after a failed backup (0 to 10, default 5).
 *
 * The defaults are exactly what the agent did before policies existed, so an installation that
 * sets nothing behaves as before, and the configuration of its machines does not change.
 */

import { BANDWIDTH_WEEKDAYS, MAX_BANDWIDTH_KBPS, minutesOfDay } from "../backup-jobs/bandwidth.js";

export const AGENT_POLICY_KEYS = [
  "backupWindow",
  "catchUp",
  "bandwidthKbps",
  "onlyOnAcPower",
  "retries",
] as const;
export type AgentPolicyKey = (typeof AGENT_POLICY_KEYS)[number];

/**
 * The settings a backup job may override. The job's upload limit is its own field
 * (`settings.bandwidthKbps` with its time windows), which takes the place of the policy's limit.
 */
export const JOB_POLICY_KEYS = [
  "backupWindow",
  "catchUp",
  "onlyOnAcPower",
  "retries",
] as const satisfies readonly AgentPolicyKey[];
export type JobPolicyKey = (typeof JOB_POLICY_KEYS)[number];

export const CATCH_UP_MODES = ["asap", "next_window"] as const;
export type CatchUpMode = (typeof CATCH_UP_MODES)[number];

/** A weekly range in which backups may start (the reading rules of bandwidth windows). */
export interface BackupWindow {
  /** Days the window starts on: 1 = Monday ... 7 = Sunday. */
  days: number[];
  /** Local start `HH:MM` (included). */
  from: string;
  /** Local end `HH:MM` (not included); not after `from` ends the next day, equal = 24 hours. */
  to: string;
}

export interface CatchUpPolicy {
  enabled: boolean;
  /** `asap`: as soon as the machine is back; `next_window`: when the next backup window opens. */
  mode: CatchUpMode;
  /** A missed backup older than this many hours is skipped; null = any age. */
  maxAgeHours: number | null;
}

/** The values of every setting. */
export interface AgentPolicyValues {
  backupWindow: BackupWindow | null;
  catchUp: CatchUpPolicy;
  bandwidthKbps: number | null;
  onlyOnAcPower: boolean;
  retries: number;
}

/** One level: a key that is present is set here, one that is absent inherits. */
export type AgentPolicySettings = Partial<AgentPolicyValues>;

/** The job's level. */
export type JobAgentPolicy = Partial<Pick<AgentPolicyValues, JobPolicyKey>>;

/** The installation's level: its settings and the ones nobody below may change. */
export interface GlobalAgentPolicy {
  settings: AgentPolicySettings;
  locks: AgentPolicyKey[];
}

export const MAX_POLICY_RETRIES = 10;
export const MAX_CATCH_UP_AGE_HOURS = 24 * 30;

/** What the agent did before policies; the values of a setting no level sets. */
export const DEFAULT_AGENT_POLICY: Readonly<AgentPolicyValues> = Object.freeze({
  backupWindow: null,
  catchUp: Object.freeze({ enabled: true, mode: "asap", maxAgeHours: null }) as CatchUpPolicy,
  bandwidthKbps: null,
  onlyOnAcPower: false,
  retries: 5,
});

export const EMPTY_GLOBAL_AGENT_POLICY: GlobalAgentPolicy = Object.freeze({
  settings: {},
  locks: [],
}) as GlobalAgentPolicy;

export type AgentPolicySource = "default" | "global" | "tenant" | "job";

export interface ResolvedPolicySetting<T> {
  value: T;
  /** The level the value comes from. */
  source: AgentPolicySource;
  /** The installation locked it: no level below may change it. */
  locked: boolean;
}

export type ResolvedAgentPolicy = {
  [K in AgentPolicyKey]: ResolvedPolicySetting<AgentPolicyValues[K]>;
};

function valueAt<K extends AgentPolicyKey>(
  level: Partial<AgentPolicyValues> | null | undefined,
  key: K,
): AgentPolicyValues[K] | undefined {
  return level?.[key] as AgentPolicyValues[K] | undefined;
}

/**
 * The effective value of every setting and where it comes from: a locked setting is the
 * installation's (its default when it locks a value it does not set); otherwise the job's, else
 * the tenant's, else the installation's, else the default. Pass `job` null for the tenant's view.
 */
export function resolveAgentPolicy(
  global: GlobalAgentPolicy | null | undefined,
  tenant: AgentPolicySettings | null | undefined,
  job: JobAgentPolicy | null | undefined,
): ResolvedAgentPolicy {
  const g = global ?? EMPTY_GLOBAL_AGENT_POLICY;
  const locks = new Set(g.locks);
  const one = <K extends AgentPolicyKey>(key: K): ResolvedPolicySetting<AgentPolicyValues[K]> => {
    const locked = locks.has(key);
    const levels: [AgentPolicySource, Partial<AgentPolicyValues> | null | undefined][] = locked
      ? [["global", g.settings]]
      : [
          ["job", (JOB_POLICY_KEYS as readonly string[]).includes(key) ? job : null],
          ["tenant", tenant],
          ["global", g.settings],
        ];
    for (const [source, level] of levels) {
      const value = valueAt(level, key);
      if (value !== undefined) {
        return { value, source, locked };
      }
    }
    return { value: DEFAULT_AGENT_POLICY[key], source: "default", locked };
  };
  return {
    backupWindow: one("backupWindow"),
    catchUp: one("catchUp"),
    bandwidthKbps: one("bandwidthKbps"),
    onlyOnAcPower: one("onlyOnAcPower"),
    retries: one("retries"),
  };
}

/**
 * What `endpoints.config.policy` holds: the effective policy of the machine, written with the rest
 * of its configuration (a change raises `configVersion`). Bandwidth and AC power keep whether the
 * installation locked them, because the machine's own values (its job's limit, its own AC switch)
 * give way only to a lock.
 */
export interface EndpointPolicy {
  backupWindow: BackupWindow | null;
  catchUp: CatchUpPolicy;
  retries: number;
  bandwidthKbps: number | null;
  bandwidthLocked: boolean;
  onlyOnAcPower: boolean;
  onlyOnAcPowerLocked: boolean;
}

/**
 * The policy to store for a machine, or undefined when it is the default in every respect (no
 * level sets anything, nothing locked): then the configuration stays byte for byte what it was
 * before policies existed.
 */
export function endpointPolicyOf(resolved: ResolvedAgentPolicy): EndpointPolicy | undefined {
  const policy: EndpointPolicy = {
    backupWindow: resolved.backupWindow.value
      ? normalizeBackupWindow(resolved.backupWindow.value)
      : null,
    catchUp: { ...resolved.catchUp.value },
    retries: resolved.retries.value,
    bandwidthKbps: resolved.bandwidthKbps.value,
    bandwidthLocked: resolved.bandwidthKbps.locked,
    onlyOnAcPower: resolved.onlyOnAcPower.value,
    onlyOnAcPowerLocked: resolved.onlyOnAcPower.locked,
  };
  const isDefault =
    policy.backupWindow === null &&
    policy.catchUp.enabled === DEFAULT_AGENT_POLICY.catchUp.enabled &&
    policy.catchUp.mode === DEFAULT_AGENT_POLICY.catchUp.mode &&
    policy.catchUp.maxAgeHours === DEFAULT_AGENT_POLICY.catchUp.maxAgeHours &&
    policy.retries === DEFAULT_AGENT_POLICY.retries &&
    policy.bandwidthKbps === null &&
    !policy.bandwidthLocked &&
    policy.onlyOnAcPower === false &&
    !policy.onlyOnAcPowerLocked;
  return isDefault ? undefined : policy;
}

/** Days sorted and unique, so equal windows compare equal. */
export function normalizeBackupWindow(window: BackupWindow): BackupWindow {
  return {
    days: [...new Set(window.days)].sort((a, b) => a - b),
    from: window.from,
    to: window.to,
  };
}

/** The wire form of the policy (`GET /agent/v1/config`, field `policy`; agent 0.4.0). */
export interface AgentPolicyWire {
  backupWindow?: BackupWindow & { timeZone: string };
  catchUp: { enabled: boolean; mode: CatchUpMode; maxAgeHours?: number };
  maxRetries: number;
}

export function agentPolicyWire(policy: EndpointPolicy, zone: string): AgentPolicyWire {
  return {
    ...(policy.backupWindow ? { backupWindow: { ...policy.backupWindow, timeZone: zone } } : {}),
    catchUp: {
      enabled: policy.catchUp.enabled,
      mode: policy.catchUp.mode,
      ...(policy.catchUp.maxAgeHours ? { maxAgeHours: policy.catchUp.maxAgeHours } : {}),
    },
    maxRetries: policy.retries,
  };
}

/**
 * A job's (or a member's) upload limit that says "unlimited" explicitly, whatever the policy's
 * limit is. A limit left empty (`null` or absent, what every job stored before this choice
 * existed) inherits the policy's limit instead. The agent reads 0 as unlimited too.
 */
export const UNLIMITED_BANDWIDTH_KBPS = 0;

/**
 * The upload limit a machine's agent gets outside the job's own windows: a locked policy limit
 * always; the job's (or the machine's) own limit when it has one, an explicit "unlimited"
 * included; else the policy's. Unlimited is `null`.
 */
export function policyBandwidthDefault(
  own: number | null,
  ownWindows: boolean,
  policy: EndpointPolicy | undefined,
): { kbps: number | null; windows: boolean } {
  if (policy?.bandwidthLocked) {
    return { kbps: policy.bandwidthKbps, windows: false };
  }
  if (own !== null || ownWindows || !policy) {
    return { kbps: own === UNLIMITED_BANDWIDTH_KBPS ? null : own, windows: ownWindows };
  }
  return { kbps: policy.bandwidthKbps, windows: false };
}

/** Whether scheduled backups wait for AC power: a lock decides alone; otherwise either asks. */
export function policyOnlyOnAcPower(own: boolean, policy: EndpointPolicy | undefined): boolean {
  if (!policy) {
    return own;
  }
  return policy.onlyOnAcPowerLocked ? policy.onlyOnAcPower : own || policy.onlyOnAcPower;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type AgentPolicyIssueCode =
  | "window_days"
  | "window_time"
  | "catch_up_mode"
  | "catch_up_max_age"
  | "bandwidth"
  | "retries"
  | "locked"
  | "unknown_key";

export interface AgentPolicyIssue {
  code: AgentPolicyIssueCode;
  /** The setting the issue is about. */
  key: string;
}

/** The problems of one level's settings (a key `allowed` does not list is refused too). */
export function agentPolicyIssues(
  settings: Record<string, unknown>,
  allowed: readonly AgentPolicyKey[] = AGENT_POLICY_KEYS,
): AgentPolicyIssue[] {
  const issues: AgentPolicyIssue[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) {
      continue;
    }
    if (!(allowed as readonly string[]).includes(key)) {
      issues.push({ code: "unknown_key", key });
      continue;
    }
    switch (key as AgentPolicyKey) {
      case "backupWindow": {
        if (value === null) break;
        const w = value as Partial<BackupWindow>;
        if (
          !Array.isArray(w.days) ||
          w.days.length === 0 ||
          !w.days.every((d) => (BANDWIDTH_WEEKDAYS as readonly unknown[]).includes(d))
        ) {
          issues.push({ code: "window_days", key });
        }
        if (minutesOfDay(w.from) === null || minutesOfDay(w.to) === null) {
          issues.push({ code: "window_time", key });
        }
        break;
      }
      case "catchUp": {
        const c = value as Partial<CatchUpPolicy>;
        if (
          typeof c.enabled !== "boolean" ||
          !(CATCH_UP_MODES as readonly unknown[]).includes(c.mode)
        ) {
          issues.push({ code: "catch_up_mode", key });
        }
        if (
          c.maxAgeHours !== null &&
          (typeof c.maxAgeHours !== "number" ||
            !Number.isInteger(c.maxAgeHours) ||
            c.maxAgeHours < 1 ||
            c.maxAgeHours > MAX_CATCH_UP_AGE_HOURS)
        ) {
          issues.push({ code: "catch_up_max_age", key });
        }
        break;
      }
      case "bandwidthKbps":
        if (
          value !== null &&
          (typeof value !== "number" ||
            !Number.isInteger(value) ||
            value < 1 ||
            value > MAX_BANDWIDTH_KBPS)
        ) {
          issues.push({ code: "bandwidth", key });
        }
        break;
      case "onlyOnAcPower":
        if (typeof value !== "boolean") issues.push({ code: "unknown_key", key });
        break;
      case "retries":
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > MAX_POLICY_RETRIES
        ) {
          issues.push({ code: "retries", key });
        }
        break;
    }
  }
  return issues;
}

/** The keys of `settings` the installation has locked (a lower level may not set them). */
export function lockedKeysSet(
  settings: Record<string, unknown> | null | undefined,
  global: GlobalAgentPolicy | null | undefined,
): AgentPolicyKey[] {
  if (!settings || !global) {
    return [];
  }
  return global.locks.filter((key) => settings[key] !== undefined);
}

/** A level's settings with only the known keys, a window normalized; `{}` for nothing. */
export function cleanAgentPolicySettings<T extends AgentPolicySettings>(settings: T): T {
  const clean: AgentPolicySettings = {};
  for (const key of AGENT_POLICY_KEYS) {
    const value = settings[key];
    if (value === undefined) continue;
    (clean as Record<string, unknown>)[key] =
      key === "backupWindow" && value !== null
        ? normalizeBackupWindow(value as BackupWindow)
        : key === "catchUp"
          ? { ...(value as CatchUpPolicy) }
          : value;
  }
  return clean as T;
}
