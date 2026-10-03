// What an endpoint job tells one machine: the job's settings with the machine's override on top,
// written into `endpoints.config` in the shape the agent has always read (`GET /agent/v1/config`).
// Pure code, shared by the API (writes the configuration when a job or its scope changes), the
// migration and their tests.

import {
  type ActiveAgentSchedule,
  type AgentConfig,
  type AgentSchedule,
  DEFAULT_ENDPOINT_RETENTION,
  isUnscheduled,
} from "../endpoints/config.js";
import { normalizeBandwidthWindows } from "./bandwidth.js";
import { endpointScheduleOf, jobScheduleFromEndpoint } from "./schedule.js";
import type {
  JobEndpointSettings,
  JobMemberOverrides,
  JobRetention,
  JobSchedule,
} from "./types.js";

/** `--exclude-larger-than` counts in powers of 1024 (restic's `G` is a GiB). */
const BYTES_PER_GIB = 1024 ** 3;

/** The fields of a job's settings that a member may override. */
export const OVERRIDABLE_SETTING_KEYS = [
  "paths",
  "excludes",
  "excludeLargerThanGib",
  "hooks",
  "bandwidthKbps",
  "bandwidthWindows",
  "retention",
] as const satisfies readonly (keyof JobEndpointSettings)[];

/** The job's settings with every field the member overrides replaced by the member's value. */
export function effectiveSettings(
  settings: JobEndpointSettings,
  overrides: JobMemberOverrides,
): JobEndpointSettings {
  // The limit and its time windows are one setting: a machine that has a limit of its own does not
  // also run the job's windows, so a limit set before windows existed keeps meaning what it said.
  const bandwidthOverridden =
    overrides.bandwidthKbps !== undefined || overrides.bandwidthWindows !== undefined;
  const { bandwidthWindows: jobWindows, ...rest } = settings;
  const merged: JobEndpointSettings =
    bandwidthOverridden || jobWindows === undefined
      ? { ...rest }
      : { ...rest, bandwidthWindows: jobWindows };
  for (const key of OVERRIDABLE_SETTING_KEYS) {
    if (overrides[key] !== undefined) {
      (merged as Record<string, unknown>)[key] = overrides[key];
    }
  }
  return merged;
}

/** The schedule a member backs up with: its own, else the job's; null when neither exists. */
export function effectiveSchedule(
  schedule: JobSchedule | null,
  overrides: JobMemberOverrides,
): JobSchedule | null {
  return overrides.schedule ?? schedule;
}

function cleanHooks(hooks: { pre?: string; post?: string }): { pre?: string; post?: string } {
  const clean: { pre?: string; post?: string } = {};
  if (hooks.pre) clean.pre = hooks.pre;
  if (hooks.post) clean.post = hooks.post;
  return clean;
}

/** Whole bytes of a limit in GiB; the agent receives bytes. */
export function gibToBytes(gib: number): number {
  return Math.round(gib * BYTES_PER_GIB);
}

/**
 * The schedule to write: the job's, in the shape the agent reads, unless the machine's own
 * already means the same (a field its kind does not use, which an older release stored as it was
 * sent, changes nothing for the agent and is not worth a new configuration version). A machine
 * without a schedule (`none`: in no job until now) always takes the job's.
 */
function scheduleToWrite(current: AgentSchedule, schedule: JobSchedule): AgentSchedule {
  const wanted = endpointScheduleOf(schedule);
  if (isUnscheduled(current)) {
    return wanted;
  }
  const own = endpointScheduleOf(jobScheduleFromEndpoint(current as ActiveAgentSchedule));
  return JSON.stringify(own) === JSON.stringify(wanted) ? current : wanted;
}

/**
 * The configuration the agent gets: `current` (which keeps what no job decides: the profile, the
 * power and shadow-copy switches) with the job's schedule and effective settings written over it.
 * A setting the job does not carry leaves the machine's own value in place. The size limit and the
 * bandwidth windows are written only when the job sets them, so a configuration without them
 * stays byte-for-byte what it was (an agent that does not know the size limit ignores it, and the
 * windows never reach the agent: the server answers with the limit that applies when it is
 * asked, `bandwidthKbps` of the configuration being the default outside every window).
 */
export function buildEndpointConfig(
  current: AgentConfig,
  schedule: JobSchedule | null,
  settings: JobEndpointSettings,
): AgentConfig {
  const { excludeLargerThanBytes: _dropped, bandwidthWindows: _windows, ...rest } = current;
  const next: AgentConfig = {
    ...rest,
    schedule: schedule ? scheduleToWrite(current.schedule, schedule) : current.schedule,
    paths: settings.paths ? [...settings.paths] : current.paths,
    excludes: settings.excludes ? [...settings.excludes] : current.excludes,
    hooks: settings.hooks ? cleanHooks(settings.hooks) : current.hooks,
    bandwidthKbps:
      settings.bandwidthKbps !== undefined ? settings.bandwidthKbps : current.bandwidthKbps,
  };
  if (typeof settings.excludeLargerThanGib === "number" && settings.excludeLargerThanGib > 0) {
    next.excludeLargerThanBytes = gibToBytes(settings.excludeLargerThanGib);
  }
  if (settings.bandwidthWindows && settings.bandwidthWindows.length > 0) {
    next.bandwidthWindows = normalizeBandwidthWindows(settings.bandwidthWindows);
  }
  return next;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}

/** A text that is the same for configurations that mean the same (key order, undefined fields). */
export function configKey(config: AgentConfig): string {
  return JSON.stringify(sortKeys({ ...config, hooks: cleanHooks(config.hooks ?? {}) }));
}

/** Whether two configurations are the same to the agent. */
export function sameEndpointConfig(a: AgentConfig, b: AgentConfig): boolean {
  return configKey(a) === configKey(b);
}

/** A retention as one comparable text. */
export function retentionKey(retention: JobRetention | undefined): string {
  return retention
    ? `${retention.keepDaily}/${retention.keepWeekly}/${retention.keepMonthly}`
    : "unset";
}

/** The retention a machine keeps its repository with: its own, else the product default. */
export function retentionOrDefault(retention: JobRetention | undefined): JobRetention {
  return retention ?? { ...DEFAULT_ENDPOINT_RETENTION };
}

/**
 * The retention to write into a machine's settings, or null when nothing needs writing: the job
 * sets none, or the machine already keeps what the job asks for (an unset retention counts as
 * the product default).
 */
export function retentionToWrite(
  effective: JobRetention | undefined,
  stored: JobRetention | undefined,
): JobRetention | null {
  if (!effective) {
    return null;
  }
  return retentionKey(retentionOrDefault(stored)) === retentionKey(effective) ? null : effective;
}
