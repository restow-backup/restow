// The migration of an older installation to backup jobs, as pure planning: what jobs the
// schedules and the machine configurations of one tenant turn into. The database step that
// carries the plan out (apps/api features/backup-jobs/migration.ts) only reads rows, calls these
// functions and writes the result; every rule lives here, so one test table covers them all.
//
// The rules (docs/ARCHITECTURE.md, "Jobs"; release notes, "Upgrade notes"):
//
// Mail, per tenant: one job from the enabled backup and verify schedules.
//   - The first enabled schedule that covers the whole tenant becomes the job's schedule (backup)
//     or restore-check schedule (verify). A tenant-wide schedule with the same cadence is a
//     duplicate and is replaced as well; one with another cadence cannot be shown in one job and
//     stays exactly as it is (it keeps running, listed as "left").
//   - A schedule of one object becomes that object's override when it runs at least as often as
//     the job's schedule: its longest pause between two runs is no longer than the job's shortest
//     gap (an object never runs less often than before, also not at night or at the weekend);
//     otherwise it stays as it is. Without any tenant-wide schedule the most common object
//     schedule is the job's, and the objects with it share the job's timer.
//   - A member runs on one schedule of a kind. An object with several schedules of one kind gets
//     the one that leaves the shortest longest pause; the others keep running as they are
//     (a duplicate of what the member runs on is replaced).
//   - Disabled schedules never ran; they are replaced too (the job says so by having no schedule
//     of that kind) and, like every replaced schedule, kept.
//   - A job covers "all objects" when a tenant-wide schedule existed, so objects that appear later
//     are still backed up; otherwise it covers the objects that had a schedule.
//   - Timers are carried over, so nothing runs early or is skipped by the switch.
//
// Endpoints, per tenant: the active machines are grouped by profile, operating system and
// schedule (exactly as the agent reads it, time zone included); every group is one job. The
// folders, exclusions, hooks, bandwidth and retention that most of a group share are the job's,
// what differs is the machine's override. Revoked machines are not scheduled and stay out, and
// so do machines without a schedule (`none`).

import {
  type ActiveAgentSchedule,
  type AgentConfig,
  DEFAULT_ENDPOINT_RETENTION,
  isUnscheduled,
} from "../endpoints/config.js";
import { type Cadence, validateCadence } from "../schedule/index.js";
import { normalizeBandwidthWindows } from "./bandwidth.js";
import { OVERRIDABLE_SETTING_KEYS, retentionKey } from "./endpoint-config.js";
import {
  type ScheduleGaps,
  endpointScheduleOf,
  jobScheduleFromCadence,
  jobScheduleFromEndpoint,
  runsAtLeastAsOften,
  scheduleGaps,
  scheduleKey,
} from "./schedule.js";
import type {
  JobEndpointSettings,
  JobMemberOverrides,
  JobRetention,
  JobSchedule,
} from "./types.js";

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

/** A backup or verify schedule row, as the migration reads it. */
export interface LegacyScheduleRow {
  readonly id: string;
  readonly kind: "backup" | "verify";
  readonly protectedObjectId: string | null;
  readonly intervalMinutes: number | null;
  readonly cron: string | null;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly nextRunAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly createdAt: Date;
}

export type LeftoverReason =
  | "different_cadence"
  | "less_frequent"
  | "invalid_cadence"
  /** The tenant had a mail job already (made by hand after the step failed for it once). */
  | "mail_job_exists";

export interface LeftoverSchedule {
  readonly id: string;
  readonly kind: "backup" | "verify";
  readonly protectedObjectId: string | null;
  readonly reason: LeftoverReason;
}

export interface PlannedMailMember {
  readonly protectedObjectId: string;
  readonly overrides: JobMemberOverrides;
  readonly nextRunAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly verifyNextRunAt: Date | null;
  readonly verifyLastRunAt: Date | null;
}

export interface MailMigrationPlan {
  /** False when the tenant has no enabled backup or verify schedule: nothing to carry over. */
  readonly create: boolean;
  readonly scopeMode: "all" | "selected";
  readonly schedule: JobSchedule | null;
  readonly nextRunAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly verifySchedule: JobSchedule | null;
  readonly verifyNextRunAt: Date | null;
  readonly verifyLastRunAt: Date | null;
  readonly members: readonly PlannedMailMember[];
  /** Ids of the schedules the job replaces (they stay, marked as replaced). */
  readonly supersede: readonly string[];
  /** Schedules that could not be carried over and keep running as before. */
  readonly leftover: readonly LeftoverSchedule[];
}

const EMPTY_MAIL_PLAN: MailMigrationPlan = {
  create: false,
  scopeMode: "selected",
  schedule: null,
  nextRunAt: null,
  lastRunAt: null,
  verifySchedule: null,
  verifyNextRunAt: null,
  verifyLastRunAt: null,
  members: [],
  supersede: [],
  leftover: [],
};

function cadenceOfRow(row: LegacyScheduleRow): Cadence {
  return { intervalMinutes: row.intervalMinutes, cron: row.cron, timezone: row.timezone };
}

function scheduleOfRow(row: LegacyScheduleRow): JobSchedule {
  return jobScheduleFromCadence(cadenceOfRow(row));
}

/** Same interval, or same cron in the same zone; the zone of an interval does not matter. */
function sameCadence(a: LegacyScheduleRow, b: LegacyScheduleRow): boolean {
  return scheduleKey(scheduleOfRow(a)) === scheduleKey(scheduleOfRow(b));
}

function byCreation(a: LegacyScheduleRow, b: LegacyScheduleRow): number {
  const time = a.createdAt.getTime() - b.createdAt.getTime();
  return time !== 0 ? time : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function earliest(dates: readonly (Date | null)[]): Date | null {
  if (dates.length === 0 || dates.some((date) => date === null)) {
    return null;
  }
  return new Date(Math.min(...dates.map((date) => (date as Date).getTime())));
}

function latest(dates: readonly (Date | null)[]): Date | null {
  const known = dates.filter((date): date is Date => date !== null);
  return known.length === 0 ? null : new Date(Math.max(...known.map((date) => date.getTime())));
}

interface KindPlan {
  readonly schedule: JobSchedule | null;
  readonly nextRunAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly supersede: string[];
  readonly leftover: LeftoverSchedule[];
  /** Objects with a schedule of this kind that the job now covers, with their own schedule when it differs. */
  readonly objects: Map<
    string,
    { schedule: JobSchedule | null; nextRunAt: Date | null; lastRunAt: Date | null }
  >;
}

/** The rows of one kind the scheduler can plan (a disabled one never ran, so it counts as usable). */
function usableRows(
  kind: "backup" | "verify",
  rows: readonly LegacyScheduleRow[],
  now: Date,
): { usable: LegacyScheduleRow[]; invalid: LegacyScheduleRow[] } {
  const usable: LegacyScheduleRow[] = [];
  const invalid: LegacyScheduleRow[] = [];
  for (const row of rows.filter((candidate) => candidate.kind === kind).sort(byCreation)) {
    if (!row.enabled || validateCadence(cadenceOfRow(row), now) === null) {
      usable.push(row);
    } else {
      // A cadence the scheduler cannot plan stays where it is: it is deferred there, as before.
      invalid.push(row);
    }
  }
  return { usable, invalid };
}

function primaryOf(rows: readonly LegacyScheduleRow[]): LegacyScheduleRow | null {
  return rows.find((row) => row.enabled && row.protectedObjectId === null) ?? null;
}

/**
 * One kind (backup or verify) of one tenant. `scopeAll` says the job covers every object of the
 * tenant: then the job's schedule can only be a tenant-wide one (an object's own schedule must not
 * start protecting the others).
 */
function planKind(
  kind: "backup" | "verify",
  rows: readonly LegacyScheduleRow[],
  scopeAll: boolean,
  now: Date,
): KindPlan {
  const supersede: string[] = [];
  const leftover: LeftoverSchedule[] = [];
  const objects: KindPlan["objects"] = new Map();
  const { usable, invalid } = usableRows(kind, rows, now);
  for (const row of invalid) {
    leftover.push({
      id: row.id,
      kind,
      protectedObjectId: row.protectedObjectId,
      reason: "invalid_cadence",
    });
  }
  const left = (row: LegacyScheduleRow, reason: LeftoverReason) =>
    leftover.push({ id: row.id, kind, protectedObjectId: row.protectedObjectId, reason });
  const tenantWide = usable.filter((row) => row.protectedObjectId === null);
  const perObject = usable.filter((row) => row.protectedObjectId !== null);
  const primary = primaryOf(usable);

  let baseRow: LegacyScheduleRow | null = null;
  let nextRunAt: Date | null = null;
  let lastRunAt: Date | null = null;

  if (primary) {
    baseRow = primary;
    nextRunAt = primary.nextRunAt;
    lastRunAt = primary.lastRunAt;
    for (const row of tenantWide) {
      if (!row.enabled || row.id === primary.id || sameCadence(row, primary)) {
        supersede.push(row.id);
      } else {
        left(row, "different_cadence");
      }
    }
  } else {
    // No tenant-wide schedule runs: what was disabled never ran, and the job is the one place now.
    for (const row of tenantWide) {
      supersede.push(row.id);
    }
    if (!scopeAll) {
      // The most common cadence among the object schedules is the job's; its objects share one timer.
      const enabled = perObject.filter((row) => row.enabled);
      const counts = new Map<string, { row: LegacyScheduleRow; count: number }>();
      for (const row of enabled) {
        const key = scheduleKey(scheduleOfRow(row));
        const entry = counts.get(key);
        if (entry) {
          entry.count++;
        } else {
          counts.set(key, { row, count: 1 });
        }
      }
      let best: { row: LegacyScheduleRow; count: number } | null = null;
      for (const entry of counts.values()) {
        if (best === null || entry.count > best.count) {
          best = entry;
        }
      }
      if (best) {
        const winner = best.row;
        baseRow = winner;
        const sharing = enabled.filter((row) => sameCadence(row, winner));
        nextRunAt = earliest(sharing.map((row) => row.nextRunAt));
        lastRunAt = latest(sharing.map((row) => row.lastRunAt));
      }
    }
  }

  const base = baseRow ? scheduleOfRow(baseRow) : null;
  // Many objects share a cadence; walk the runs of each cadence once.
  const gapsSeen = new Map<string, ScheduleGaps | null>();
  const gapsOf = (schedule: JobSchedule): ScheduleGaps | null => {
    const key = scheduleKey(schedule);
    if (!gapsSeen.has(key)) {
      gapsSeen.set(key, scheduleGaps(schedule, now));
    }
    return gapsSeen.get(key) ?? null;
  };
  const baseGaps = primary && base ? gapsOf(base) : null;
  const pauseOf = (row: LegacyScheduleRow) =>
    gapsOf(scheduleOfRow(row))?.max ?? Number.POSITIVE_INFINITY;
  const isBase = (row: LegacyScheduleRow) => baseRow !== null && sameCadence(row, baseRow);
  // An override must protect the object at least as well as the tenant-wide schedule it replaces.
  const mayReplaceBase = (row: LegacyScheduleRow) =>
    !primary || runsAtLeastAsOften(gapsOf(scheduleOfRow(row)), baseGaps);

  const byObject = new Map<string, LegacyScheduleRow[]>();
  for (const row of perObject) {
    if (!row.enabled) {
      supersede.push(row.id);
      continue;
    }
    const objectId = row.protectedObjectId as string;
    byObject.set(objectId, [...(byObject.get(objectId) ?? []), row]);
  }
  for (const [objectId, own] of byObject) {
    // A member runs on one schedule of this kind: the job's, or one override. Of the object's own
    // schedules that may be the override, the one with the shortest longest pause is (the first
    // made on a tie); without a tenant-wide schedule, the job's cadence wins a tie.
    let chosen: LegacyScheduleRow | null = null;
    for (const row of own) {
      if (isBase(row) || !mayReplaceBase(row)) {
        continue;
      }
      if (chosen === null || pauseOf(row) < pauseOf(chosen)) {
        chosen = row;
      }
    }
    if (chosen && !primary) {
      const sharesJob = own.find(isBase);
      if (sharesJob && pauseOf(sharesJob) <= pauseOf(chosen)) {
        chosen = null;
      }
    }
    const runsOn = chosen ? scheduleOfRow(chosen) : base;
    let taken = false;
    for (const row of own) {
      if (
        row === chosen ||
        (runsOn !== null && scheduleKey(scheduleOfRow(row)) === scheduleKey(runsOn))
      ) {
        // What the member runs on now (a duplicate of it included): the job carries it.
        supersede.push(row.id);
        taken = true;
      } else if (!mayReplaceBase(row)) {
        // Less often than the job, or with a longer pause somewhere (nights, weekends): replacing
        // the job's schedule for this object would protect it less than before, so the old
        // schedule keeps running next to the job.
        left(row, "less_frequent");
      } else {
        // A second schedule of the object with another cadence: one member cannot show both,
        // so it keeps running next to the job.
        left(row, "different_cadence");
      }
    }
    if (chosen) {
      objects.set(objectId, {
        schedule: scheduleOfRow(chosen),
        nextRunAt: chosen.nextRunAt,
        lastRunAt: chosen.lastRunAt,
      });
    } else if (taken) {
      // The job's own cadence: nothing of its own to carry (the timer is the job's).
      objects.set(objectId, { schedule: null, nextRunAt: null, lastRunAt: null });
    }
  }
  return { schedule: base, nextRunAt, lastRunAt, supersede, leftover, objects };
}

/** What the backup and verify schedules of one tenant turn into (see the rules at the top of this file). */
export function planMailMigration(
  rows: readonly LegacyScheduleRow[],
  now: Date,
): MailMigrationPlan {
  const scopeAll =
    primaryOf(usableRows("backup", rows, now).usable) !== null ||
    primaryOf(usableRows("verify", rows, now).usable) !== null;
  const backup = planKind("backup", rows, scopeAll, now);
  const verify = planKind("verify", rows, scopeAll, now);
  const scopeMode = scopeAll ? "all" : "selected";

  const ids = new Set<string>([...backup.objects.keys(), ...verify.objects.keys()]);
  const members: PlannedMailMember[] = [];
  for (const protectedObjectId of [...ids].sort()) {
    const own = backup.objects.get(protectedObjectId);
    const ownVerify = verify.objects.get(protectedObjectId);
    const overrides: JobMemberOverrides = {
      ...(own?.schedule ? { schedule: own.schedule } : {}),
      ...(ownVerify?.schedule ? { verifySchedule: ownVerify.schedule } : {}),
    };
    // Covering every object already, a member that only repeats the job's cadence is not needed.
    if (scopeAll && Object.keys(overrides).length === 0) {
      continue;
    }
    members.push({
      protectedObjectId,
      overrides,
      nextRunAt: own?.schedule ? own.nextRunAt : null,
      lastRunAt: own?.schedule ? own.lastRunAt : null,
      verifyNextRunAt: ownVerify?.schedule ? ownVerify.nextRunAt : null,
      verifyLastRunAt: ownVerify?.schedule ? ownVerify.lastRunAt : null,
    });
  }
  const create = backup.schedule !== null || verify.schedule !== null || members.length > 0;
  if (!create) {
    return EMPTY_MAIL_PLAN;
  }
  return {
    create,
    scopeMode,
    schedule: backup.schedule,
    nextRunAt: backup.nextRunAt,
    lastRunAt: backup.lastRunAt,
    verifySchedule: verify.schedule,
    verifyNextRunAt: verify.nextRunAt,
    verifyLastRunAt: verify.lastRunAt,
    members,
    supersede: [...backup.supersede, ...verify.supersede],
    leftover: [...backup.leftover, ...verify.leftover],
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** A machine as the migration reads it. */
export interface LegacyEndpointRow {
  readonly id: string;
  readonly os: string;
  readonly profile: "server" | "client";
  readonly config: AgentConfig;
  /** The part of the machine's server-side settings a job decides. */
  readonly settings: { readonly retention?: JobRetention };
  readonly createdAt: Date;
}

export interface PlannedEndpointMember {
  readonly endpointId: string;
  readonly overrides: JobMemberOverrides;
}

export interface EndpointJobPlan {
  readonly os: string;
  readonly profile: "server" | "client";
  readonly schedule: JobSchedule;
  readonly settings: JobEndpointSettings;
  readonly members: readonly PlannedEndpointMember[];
}

/** The settings of a machine that a job decides, as the machine has them today. */
function settingsOfEndpoint(row: LegacyEndpointRow): JobEndpointSettings {
  const config = row.config;
  const settings: JobEndpointSettings = {
    paths: [...config.paths],
    excludes: [...config.excludes],
    hooks: { ...config.hooks },
    bandwidthKbps: config.bandwidthKbps ?? null,
  };
  if (config.bandwidthWindows && config.bandwidthWindows.length > 0) {
    settings.bandwidthWindows = normalizeBandwidthWindows(config.bandwidthWindows);
  }
  if (row.settings.retention) {
    settings.retention = { ...row.settings.retention };
  }
  return settings;
}

function settingKey(
  key: (typeof OVERRIDABLE_SETTING_KEYS)[number],
  settings: JobEndpointSettings,
): string {
  if (key === "retention") {
    return retentionKey(settings.retention);
  }
  return JSON.stringify(settings[key] ?? null);
}

/** What most of the machines share as one text: the combination of the job-owned settings. */
function settingsKey(settings: JobEndpointSettings): string {
  return OVERRIDABLE_SETTING_KEYS.map((key) => `${key}=${settingKey(key, settings)}`).join("|");
}

/**
 * A machine's schedule exactly as the agent receives it, time zone included: `scheduleKey` leaves
 * the zone of an interval out (it does not change when an interval runs), but the agent's
 * configuration carries it, so machines that differ in it would get a rewritten configuration
 * from one shared job.
 */
function agentScheduleKey(row: LegacyEndpointRow): string {
  return JSON.stringify(endpointScheduleOf(jobScheduleFromEndpoint(activeScheduleOf(row))));
}

/** The schedule of a machine that has one (the planner leaves out machines without). */
function activeScheduleOf(row: LegacyEndpointRow): ActiveAgentSchedule {
  return row.config.schedule as ActiveAgentSchedule;
}

function byEndpointCreation(a: LegacyEndpointRow, b: LegacyEndpointRow): number {
  const time = a.createdAt.getTime() - b.createdAt.getTime();
  return time !== 0 ? time : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The jobs the active machines of one tenant turn into. A group is the machines with the same
 * profile, operating system and schedule (as the agent reads it, time zone included); its job carries the settings most of them share (a tie
 * goes to the machine enrolled first), every other machine an override with just the settings
 * that differ. Applying the job to every machine gives the configuration it already has.
 */
export function planEndpointMigration(rows: readonly LegacyEndpointRow[]): EndpointJobPlan[] {
  const groups = new Map<string, LegacyEndpointRow[]>();
  // A machine without a schedule (`none`, enrolled since 0.2.1) waits for a job of its admin's
  // choosing; there is nothing to carry over.
  const scheduled = rows.filter((row) => !isUnscheduled(row.config.schedule));
  for (const row of scheduled.sort(byEndpointCreation)) {
    const key = `${row.profile}|${row.os}|${agentScheduleKey(row)}`;
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  const plans: EndpointJobPlan[] = [];
  for (const group of groups.values()) {
    const first = group[0] as LegacyEndpointRow;
    const counts = new Map<string, { settings: JobEndpointSettings; count: number }>();
    for (const row of group) {
      const settings = settingsOfEndpoint(row);
      const key = settingsKey(settings);
      const entry = counts.get(key);
      if (entry) {
        entry.count++;
      } else {
        counts.set(key, { settings, count: 1 });
      }
    }
    // Map iteration follows insertion, so a tie keeps the machine enrolled first.
    let base: { settings: JobEndpointSettings; count: number } | null = null;
    for (const entry of counts.values()) {
      if (base === null || entry.count > base.count) {
        base = entry;
      }
    }
    const jobSettings = (base as { settings: JobEndpointSettings }).settings;
    const members: PlannedEndpointMember[] = group.map((row) => {
      const own = settingsOfEndpoint(row);
      const overrides: JobMemberOverrides = {};
      for (const key of OVERRIDABLE_SETTING_KEYS) {
        if (settingKey(key, own) === settingKey(key, jobSettings)) {
          continue;
        }
        if (key === "retention") {
          // A machine on the product default under a job that sets one keeps the default explicitly.
          overrides.retention = own.retention ?? { ...DEFAULT_ENDPOINT_RETENTION };
        } else if (key === "bandwidthWindows") {
          overrides.bandwidthWindows = own.bandwidthWindows ?? [];
        } else {
          (overrides as Record<string, unknown>)[key] = own[key] ?? null;
        }
      }
      // The limit and its windows are one setting (effectiveSettings): where windows are in play and
      // either differs, both are stated. Machines of an older release have no windows and keep an
      // override that says no more than it did.
      if (
        (overrides.bandwidthKbps !== undefined || overrides.bandwidthWindows !== undefined) &&
        (own.bandwidthWindows !== undefined || jobSettings.bandwidthWindows !== undefined)
      ) {
        overrides.bandwidthKbps = own.bandwidthKbps ?? null;
        overrides.bandwidthWindows = own.bandwidthWindows ?? [];
      }
      return { endpointId: row.id, overrides };
    });
    plans.push({
      os: first.os,
      profile: first.profile,
      // In the shape the agent reads, without a field its kind does not use.
      schedule: jobScheduleFromEndpoint(
        endpointScheduleOf(jobScheduleFromEndpoint(activeScheduleOf(first))),
      ),
      settings: jobSettings,
      members,
    });
  }
  return plans;
}
