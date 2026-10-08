import {
  type CadenceDraft,
  FALLBACK_TIME_ZONE,
  cadenceDraftFrom,
  checkCadence,
  newCadenceDraft,
} from "@/features/schedules/presenters";
import type { StoredCadence } from "@/features/schedules/presets";

import {
  type BackupJob,
  type CreateBackupJobInput,
  type JobCandidate,
  type JobDefaults,
  type JobEndpointSettings,
  type JobKind,
  type JobMember,
  type JobMemberOverrides,
  type JobRetention,
  type JobSchedule,
  type JobScopeMode,
  LIMITS,
  type MemberInput,
  type MemberKind,
  type UpdateBackupJobInput,
} from "./api.js";
import {
  type WindowDraft,
  checkWindowDrafts,
  windowDraftsOf,
  windowsKey,
  windowsOfDrafts,
} from "./bandwidth-windows.js";
import { excludesProblem, parseLargerThanGib } from "./exclusions.js";
import { pathsProblem } from "./folders.js";

/**
 * The job editor as data: a draft the fields edit, the checks that mirror the
 * API's schemas (apps/api backup-jobs/schemas.ts), and the requests that hold
 * only what the person changed. Pure, so it is tested without a browser.
 */

/** What the API shows instead of a hook text the viewer may not see. Never saved back. */
export const MASKED_HOOK = "********";

// --- Schedules -------------------------------------------------------------------------

/** A mail schedule (interval or cron) from the cadence the form describes. */
export function jobScheduleOfCadence(cadence: StoredCadence, timeZone: string): JobSchedule {
  return cadence.intervalMinutes !== null
    ? { kind: "interval", intervalMinutes: cadence.intervalMinutes, timeZone }
    : { kind: "cron", cron: cadence.cron ?? "", timeZone };
}

/** The cadence of a mail schedule; `daily` is the cron expression it stands for; null when it has none. */
export function cadenceOfJobSchedule(schedule: JobSchedule): StoredCadence | null {
  switch (schedule.kind) {
    case "interval":
      return typeof schedule.intervalMinutes === "number"
        ? { intervalMinutes: schedule.intervalMinutes, cron: null }
        : null;
    case "cron":
      return typeof schedule.cron === "string" && schedule.cron.trim() !== ""
        ? { intervalMinutes: null, cron: schedule.cron.trim() }
        : null;
    case "daily": {
      const match = /^(\d{2}):(\d{2})$/.exec(schedule.timeOfDay ?? "");
      return match
        ? { intervalMinutes: null, cron: `${Number(match[2])} ${Number(match[1])} * * *` }
        : null;
    }
    default:
      return null;
  }
}

/** The form state of a mail schedule; a missing one starts from the fallback. */
export function cadenceDraftOfSchedule(
  schedule: JobSchedule | null | undefined,
  fallback: JobSchedule | null | undefined,
  zone: string,
): CadenceDraft {
  const source = schedule ?? fallback ?? null;
  const cadence = source ? cadenceOfJobSchedule(source) : null;
  return cadence
    ? cadenceDraftFrom(cadence, source?.timeZone || zone)
    : newCadenceDraft(source?.timeZone || zone);
}

export type EndpointScheduleKind = "interval" | "daily" | "on_connect";
export const ENDPOINT_SCHEDULE_KINDS: readonly EndpointScheduleKind[] = [
  "daily",
  "interval",
  "on_connect",
];

/** A machine schedule as the form holds it; numbers stay text while they are typed. */
export interface EndpointScheduleDraft {
  kind: EndpointScheduleKind;
  /** Minutes: the interval, or the least time between two backups on connect (may be empty). */
  intervalMinutes: string;
  /** `HH:MM`. */
  timeOfDay: string;
  timeZone: string;
}

export function newEndpointScheduleDraft(zone: string): EndpointScheduleDraft {
  return { kind: "daily", intervalMinutes: "", timeOfDay: "22:00", timeZone: zone };
}

export function endpointScheduleDraftOf(
  schedule: JobSchedule | null | undefined,
  fallback: JobSchedule | null | undefined,
  zone: string,
): EndpointScheduleDraft {
  const source = schedule ?? fallback ?? null;
  const base = newEndpointScheduleDraft(source?.timeZone || zone);
  if (!source) {
    return base;
  }
  const minutes = source.intervalMinutes === undefined ? "" : String(source.intervalMinutes);
  switch (source.kind) {
    case "daily":
      return { ...base, kind: "daily", timeOfDay: source.timeOfDay ?? base.timeOfDay };
    case "interval":
      return { ...base, kind: "interval", intervalMinutes: minutes };
    case "on_connect":
      return { ...base, kind: "on_connect", intervalMinutes: minutes };
    default:
      return base;
  }
}

function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

/** The schedule a machine form describes, with only the fields its kind uses. */
export function jobScheduleOfEndpointDraft(draft: EndpointScheduleDraft): JobSchedule {
  const timeZone = draft.timeZone.trim();
  switch (draft.kind) {
    case "daily":
      return { kind: "daily", timeOfDay: draft.timeOfDay, timeZone };
    case "interval":
      return {
        kind: "interval",
        intervalMinutes: wholeNumber(draft.intervalMinutes) ?? 0,
        timeZone,
      };
    default: {
      const minutes = wholeNumber(draft.intervalMinutes);
      return minutes === null
        ? { kind: "on_connect", timeZone }
        : { kind: "on_connect", intervalMinutes: minutes, timeZone };
    }
  }
}

export interface FormProblem {
  /** The message is `backupjobs:problems.form.<code>`. */
  code: string;
  values?: Record<string, string | number>;
}

export type EndpointScheduleField = "intervalMinutes" | "timeOfDay" | "timeZone";

/** What the API would refuse about a machine schedule (5 minutes to a week). */
export function checkEndpointSchedule(
  draft: EndpointScheduleDraft,
): Partial<Record<EndpointScheduleField, FormProblem>> {
  const problems: Partial<Record<EndpointScheduleField, FormProblem>> = {};
  if (draft.kind === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.timeOfDay)) {
    problems.timeOfDay = { code: "timeOfDay" };
  }
  if (draft.timeZone.trim() === "") {
    problems.timeZone = { code: "required" };
  }
  if (draft.kind === "interval" || draft.kind === "on_connect") {
    const text = draft.intervalMinutes.trim();
    if (text === "") {
      if (draft.kind === "interval") {
        problems.intervalMinutes = { code: "required" };
      }
    } else {
      const minutes = wholeNumber(text);
      if (minutes === null) {
        problems.intervalMinutes = { code: "integer" };
      } else if (minutes < LIMITS.endpointIntervalMin || minutes > LIMITS.endpointIntervalMax) {
        problems.intervalMinutes = {
          code: "range",
          values: { min: LIMITS.endpointIntervalMin, max: LIMITS.endpointIntervalMax },
        };
      }
    }
  }
  return problems;
}

// --- Machine settings --------------------------------------------------------------------

/** The settings of a machine job, or the part of them one member does differently. */
export interface SettingsDraft {
  /** The folders; the API wants at least one. */
  paths: string[];
  /** The stored patterns (chips and own patterns together). */
  excludes: string[];
  largerEnabled: boolean;
  /** GB; text while typed. */
  largerGib: string;
  /** kbit/s; empty is unlimited. */
  bandwidth: string;
  /** The time windows of the limit, one row each; read in the schedule's time zone. */
  bandwidthWindows: WindowDraft[];
  preHook: string;
  postHook: string;
  /** The API hid the hook texts from this viewer: they cannot be edited, and nothing is saved over them. */
  hooksHidden: boolean;
  /** `false`: every machine keeps its own retention. */
  retentionOwn: boolean;
  keepDaily: string;
  keepWeekly: string;
  keepMonthly: string;
}

const FALLBACK_RETENTION: JobRetention = { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 };

export function settingsDraftOf(
  settings: JobEndpointSettings | null | undefined,
  retention: JobRetention = FALLBACK_RETENTION,
): SettingsDraft {
  const s = settings ?? {};
  const own = s.retention ?? retention;
  return {
    paths: [...(s.paths ?? [])],
    excludes: [...(s.excludes ?? [])],
    largerEnabled: typeof s.excludeLargerThanGib === "number",
    largerGib: typeof s.excludeLargerThanGib === "number" ? String(s.excludeLargerThanGib) : "",
    bandwidth: typeof s.bandwidthKbps === "number" ? String(s.bandwidthKbps) : "",
    bandwidthWindows: windowDraftsOf(s.bandwidthWindows),
    preHook: s.hooks?.pre ?? "",
    postHook: s.hooks?.post ?? "",
    hooksHidden: s.hooks?.pre === MASKED_HOOK || s.hooks?.post === MASKED_HOOK,
    retentionOwn: s.retention !== undefined,
    keepDaily: String(own.keepDaily),
    keepWeekly: String(own.keepWeekly),
    keepMonthly: String(own.keepMonthly),
  };
}

/** Which groups of the settings a draft carries (a member's overrides carry only the ones switched on). */
export interface SettingsParts {
  folders: boolean;
  exclusions: boolean;
  bandwidth: boolean;
  hooks: boolean;
  retention: boolean;
}

export const ALL_SETTINGS_PARTS: SettingsParts = {
  folders: true,
  exclusions: true,
  bandwidth: true,
  hooks: true,
  retention: true,
};

export type SettingsField =
  | "paths"
  | "excludes"
  | "larger"
  | "bandwidth"
  | "bandwidthWindows"
  | "hooks"
  | "keepDaily"
  | "keepWeekly"
  | "keepMonthly";

export type SettingsProblems = Partial<Record<SettingsField, FormProblem>>;

function rangeProblem(text: string, min: number, max: number): FormProblem | null {
  const trimmed = text.trim();
  if (trimmed === "") return { code: "required" };
  const value = wholeNumber(trimmed);
  if (value === null) return { code: "integer" };
  return value < min || value > max ? { code: "range", values: { min, max } } : null;
}

/** Everything the API would refuse about the settings, found before the request. */
export function checkSettings(
  draft: SettingsDraft,
  parts: SettingsParts = ALL_SETTINGS_PARTS,
): SettingsProblems {
  const problems: SettingsProblems = {};

  if (parts.folders) {
    const problem = pathsProblem(draft.paths);
    if (problem) {
      problems.paths = {
        code: `paths.${problem.code}`,
        values: {
          ...("max" in problem && problem.max !== undefined ? { max: problem.max } : {}),
          ...("value" in problem ? { value: problem.value } : {}),
        },
      };
    }
  }

  if (parts.exclusions) {
    const problem = excludesProblem(draft.excludes);
    if (problem) {
      problems.excludes = {
        code: `excludes.${problem.code}`,
        values: {
          ...("max" in problem ? { max: problem.max } : {}),
          ...("value" in problem ? { value: problem.value } : {}),
        },
      };
    }
    if (draft.largerEnabled && parseLargerThanGib(draft.largerGib) === null) {
      problems.larger = {
        code: "larger",
        values: { max: LIMITS.excludeLargerThanGibMax },
      };
    }
  }

  if (parts.bandwidth && draft.bandwidth.trim() !== "") {
    const problem = rangeProblem(draft.bandwidth, 1, LIMITS.bandwidthMaxKbps);
    if (problem) {
      problems.bandwidth = problem;
    }
  }
  // What is wrong in a row is said at the row (`checkWindowDrafts`); this only blocks the save.
  if (parts.bandwidth && checkWindowDrafts(draft.bandwidthWindows).invalid) {
    problems.bandwidthWindows = { code: "windows.fix" };
  }

  if (parts.hooks) {
    if (draft.hooksHidden) {
      problems.hooks = { code: "hooksHidden" };
    } else if (
      draft.preHook.length > LIMITS.hookLength ||
      draft.postHook.length > LIMITS.hookLength
    ) {
      problems.hooks = { code: "hookTooLong", values: { max: LIMITS.hookLength } };
    }
  }

  if (parts.retention && draft.retentionOwn) {
    const checks: [SettingsField, string, number][] = [
      ["keepDaily", draft.keepDaily, LIMITS.keepDaily],
      ["keepWeekly", draft.keepWeekly, LIMITS.keepWeekly],
      ["keepMonthly", draft.keepMonthly, LIMITS.keepMonthly],
    ];
    for (const [field, text, max] of checks) {
      const problem = rangeProblem(text, 0, max);
      if (problem) {
        problems[field] = problem;
      }
    }
  }
  return problems;
}

export function hasProblems(problems: object): boolean {
  return Object.keys(problems).length > 0;
}

function hooksOf(draft: SettingsDraft): { pre?: string; post?: string } {
  const pre = draft.preHook.trim();
  const post = draft.postHook.trim();
  return { ...(pre ? { pre } : {}), ...(post ? { post } : {}) };
}

/**
 * How much stricter a machine retention gets: per kind, how many restore points fewer each
 * machine keeps (the most the next retention run removes because of the change). Null when no
 * value goes down, or the draft leaves each machine its own retention.
 */
export function retentionReduction(
  before: JobRetention,
  draft: SettingsDraft,
): JobRetention | null {
  if (!draft.retentionOwn) {
    return null;
  }
  const after = retentionOf(draft);
  const less = {
    keepDaily: Math.max(0, before.keepDaily - after.keepDaily),
    keepWeekly: Math.max(0, before.keepWeekly - after.keepWeekly),
    keepMonthly: Math.max(0, before.keepMonthly - after.keepMonthly),
  };
  return less.keepDaily + less.keepWeekly + less.keepMonthly > 0 ? less : null;
}

function retentionOf(draft: SettingsDraft): JobRetention {
  return {
    keepDaily: wholeNumber(draft.keepDaily) ?? 0,
    keepWeekly: wholeNumber(draft.keepWeekly) ?? 0,
    keepMonthly: wholeNumber(draft.keepMonthly) ?? 0,
  };
}

/**
 * The settings object a job is saved with. The API replaces the whole object,
 * so everything the form shows is in it: folders (when there are any), the
 * patterns, the size limit (null lifts it), the hooks (none: an empty object),
 * the bandwidth (null: unlimited) and the retention when the job sets one.
 */
export function settingsOfDraft(draft: SettingsDraft): JobEndpointSettings {
  return {
    ...(draft.paths.length > 0 ? { paths: draft.paths.map((path) => path.trim()) } : {}),
    excludes: draft.excludes.map((pattern) => pattern.trim()),
    excludeLargerThanGib: draft.largerEnabled ? parseLargerThanGib(draft.largerGib) : null,
    hooks: hooksOf(draft),
    bandwidthKbps: draft.bandwidth.trim() === "" ? null : wholeNumber(draft.bandwidth),
    // A job without windows stores none: leaving the key out removes the ones it had.
    ...(draft.bandwidthWindows.length > 0
      ? { bandwidthWindows: windowsOfDrafts(draft.bandwidthWindows) }
      : {}),
    ...(draft.retentionOwn ? { retention: retentionOf(draft) } : {}),
  };
}

// --- The job draft -----------------------------------------------------------------------

/** One object or machine of the scope as the editor holds it. */
export interface SelectedMember {
  id: string;
  kind: MemberKind | null;
  /** Null until the list that knows the name has loaded. */
  name: string | null;
  detail: string | null;
  /** The other job it belongs to now, when the person chose to move it here. */
  job: { id: string; name: string } | null;
  /** What it does differently; kept when the scope is saved again. */
  overrides?: JobMemberOverrides;
}

export function selectedOfCandidate(candidate: JobCandidate): SelectedMember {
  return {
    id: candidate.targetId,
    kind: candidate.kind,
    name: candidate.name,
    detail: candidate.detail,
    job: candidate.job,
  };
}

export function selectedOfMember(member: JobMember): SelectedMember {
  return {
    id: member.targetId,
    kind: member.kind,
    name: member.name,
    detail: member.detail,
    job: null,
    ...(Object.keys(member.overrides).length > 0 ? { overrides: member.overrides } : {}),
  };
}

export interface JobDraft {
  kind: JobKind;
  name: string;
  /** Mail jobs only; a machine job cannot be paused. */
  enabled: boolean;
  /** Mail jobs only: archive the mailboxes through journaling. */
  archive: boolean;
  /** Mail jobs: run on a schedule; off means the job runs when someone starts it. */
  scheduleOn: boolean;
  cadence: CadenceDraft;
  /** Machine jobs. */
  endpointSchedule: EndpointScheduleDraft;
  /** Mail jobs: restore checks on a schedule of their own. */
  verifyOn: boolean;
  verifyCadence: CadenceDraft;
  /** Mail jobs: the retention policy; null follows the tenant default. */
  retentionPolicyId: string | null;
  settings: SettingsDraft;
  scopeMode: JobScopeMode;
  selected: SelectedMember[];
  /** Ids of selected objects or machines that belong to another job and are to be taken over. */
  moves: string[];
}

/** A new job of this kind, started from the tenant's recommended values. */
export function newJobDraft(kind: JobKind, defaults: JobDefaults | undefined): JobDraft {
  const zone = defaults?.timeZone ?? FALLBACK_TIME_ZONE;
  return {
    kind,
    name: "",
    enabled: true,
    archive: false,
    scheduleOn: true,
    cadence: cadenceDraftOfSchedule(
      kind === "mail" ? (defaults?.schedule ?? null) : null,
      null,
      zone,
    ),
    endpointSchedule: endpointScheduleDraftOf(
      kind === "endpoint" ? (defaults?.schedule ?? null) : null,
      null,
      zone,
    ),
    verifyOn: kind === "mail" && (defaults === undefined || defaults.verifySchedule !== null),
    verifyCadence: cadenceDraftOfSchedule(defaults?.verifySchedule ?? null, null, zone),
    retentionPolicyId: null,
    settings: settingsDraftOf(
      kind === "endpoint" ? defaults?.settings : {},
      defaults?.endpointRetention,
    ),
    scopeMode: "selected",
    selected: [],
    moves: [],
  };
}

/** The editor state of an existing job (the members are filled in once they are loaded). */
export function draftOfJob(
  job: BackupJob,
  members: readonly JobMember[],
  defaults: JobDefaults | undefined,
): JobDraft {
  const zone = defaults?.timeZone ?? job.schedule?.timeZone ?? FALLBACK_TIME_ZONE;
  return {
    kind: job.kind,
    name: job.name,
    enabled: job.enabled,
    archive: job.archive,
    scheduleOn: job.kind === "mail" ? job.schedule !== null : true,
    cadence: cadenceDraftOfSchedule(job.kind === "mail" ? job.schedule : null, null, zone),
    endpointSchedule: endpointScheduleDraftOf(
      job.kind === "endpoint" ? job.schedule : null,
      defaults?.schedule,
      zone,
    ),
    verifyOn: job.verifySchedule !== null,
    verifyCadence: cadenceDraftOfSchedule(job.verifySchedule, defaults?.verifySchedule, zone),
    retentionPolicyId: job.retention.policyId,
    settings: settingsDraftOf(job.settings, job.retention.keep ?? defaults?.endpointRetention),
    scopeMode: job.scopeMode,
    selected: members.filter((member) => member.explicit).map(selectedOfMember),
    moves: [],
  };
}

export interface JobProblems {
  name?: FormProblem;
  scope?: FormProblem;
  /** A mail schedule's problem is the cadence fields' own; this only says that there is one. */
  cadence?: boolean;
  verifyCadence?: boolean;
  endpointSchedule?: Partial<Record<EndpointScheduleField, FormProblem>>;
  settings?: SettingsProblems;
}

/** Everything the API would refuse about the draft, found before the request. */
export function checkJobDraft(draft: JobDraft): JobProblems {
  const problems: JobProblems = {};
  const name = draft.name.trim();
  if (name === "") {
    problems.name = { code: "nameRequired" };
  } else if (name.length > LIMITS.name) {
    problems.name = { code: "nameTooLong", values: { max: LIMITS.name } };
  }
  if (draft.scopeMode === "selected" && draft.selected.length > LIMITS.members) {
    problems.scope = { code: "tooManyMembers", values: { max: LIMITS.members } };
  }
  if (draft.kind === "mail") {
    if (draft.scheduleOn && !checkCadence(draft.cadence).ok) {
      problems.cadence = true;
    }
    if (draft.verifyOn && !checkCadence(draft.verifyCadence).ok) {
      problems.verifyCadence = true;
    }
  } else {
    const schedule = checkEndpointSchedule(draft.endpointSchedule);
    if (hasProblems(schedule)) {
      problems.endpointSchedule = schedule;
    }
    const settings = checkSettings(draft.settings);
    if (hasProblems(settings)) {
      problems.settings = settings;
    }
  }
  return problems;
}

export function jobHasProblems(problems: JobProblems): boolean {
  return hasProblems(problems);
}

function mailScheduleOf(draft: CadenceDraft): JobSchedule | null {
  const check = checkCadence(draft);
  return check.ok ? jobScheduleOfCadence(check.cadence, draft.timezone) : null;
}

/** The schedule of the draft as the API takes it (null: none). */
export function scheduleOfDraft(draft: JobDraft): JobSchedule | null {
  return draft.kind === "mail"
    ? draft.scheduleOn
      ? mailScheduleOf(draft.cadence)
      : null
    : jobScheduleOfEndpointDraft(draft.endpointSchedule);
}

export function verifyScheduleOfDraft(draft: JobDraft): JobSchedule | null {
  return draft.kind === "mail" && draft.verifyOn ? mailScheduleOf(draft.verifyCadence) : null;
}

export function memberInputsOf(selected: readonly SelectedMember[]): MemberInput[] {
  return selected.map((member) => ({
    id: member.id,
    ...(member.overrides && Object.keys(member.overrides).length > 0
      ? { overrides: member.overrides }
      : {}),
  }));
}

/** The request that creates the job. Call `checkJobDraft` first: this assumes valid input. */
export function createInputOf(
  draft: JobDraft,
  options: { moveMembers?: boolean } = {},
): CreateBackupJobInput {
  const move = options.moveMembers ?? draft.moves.length > 0;
  return {
    kind: draft.kind,
    name: draft.name.trim(),
    schedule: scheduleOfDraft(draft),
    ...(draft.kind === "mail" ? { verifySchedule: verifyScheduleOfDraft(draft) } : {}),
    scope: {
      mode: draft.scopeMode,
      members: draft.scopeMode === "all" ? [] : memberInputsOf(draft.selected),
    },
    ...(draft.kind === "mail" ? { retentionPolicyId: draft.retentionPolicyId } : {}),
    settings: draft.kind === "endpoint" ? settingsOfDraft(draft.settings) : {},
    enabled: draft.kind === "mail" ? draft.enabled : true,
    ...(draft.kind === "mail" && draft.archive ? { archive: true } : {}),
    ...(move ? { moveMembers: true } : {}),
  };
}

/** A stable text for a schedule, to tell two apart (the fields its kind uses). */
export function scheduleKeyOf(schedule: JobSchedule | null | undefined): string {
  if (!schedule) return "none";
  switch (schedule.kind) {
    case "interval":
      return `interval:${schedule.intervalMinutes}@${schedule.timeZone}`;
    case "cron":
      return `cron:${(schedule.cron ?? "").trim().replace(/\s+/g, " ")}@${schedule.timeZone}`;
    case "daily":
      return `daily:${schedule.timeOfDay}@${schedule.timeZone}`;
    default:
      return `on_connect:${schedule.intervalMinutes ?? ""}@${schedule.timeZone}`;
  }
}

/** The mail schedule as the API stores it: `daily` is its cron expression, an interval keeps its zone. */
function normalizedMailKey(schedule: JobSchedule | null): string {
  if (!schedule) return "none";
  const cadence = cadenceOfJobSchedule(schedule);
  return cadence
    ? scheduleKeyOf(jobScheduleOfCadence(cadence, schedule.timeZone))
    : scheduleKeyOf(schedule);
}

function stableSettingsKey(settings: JobEndpointSettings): string {
  const {
    paths,
    excludes,
    excludeLargerThanGib,
    hooks,
    bandwidthKbps,
    bandwidthWindows,
    retention,
  } = settings;
  return JSON.stringify({
    paths: paths ?? null,
    excludes: excludes ?? null,
    larger: excludeLargerThanGib ?? null,
    hooks: { pre: hooks?.pre ?? "", post: hooks?.post ?? "" },
    bandwidth: bandwidthKbps ?? null,
    windows: windowsKey(bandwidthWindows),
    retention: retention ?? null,
  });
}

/**
 * The PATCH body with only the parts that differ from what the server holds, or
 * null when nothing did. The settings are sent whole (the API replaces them).
 * Call `checkJobDraft` first: this assumes valid input.
 */
export function updateInputOf(job: BackupJob, draft: JobDraft): UpdateBackupJobInput | null {
  const patch: UpdateBackupJobInput = {};
  const name = draft.name.trim();
  if (name !== job.name) {
    patch.name = name;
  }
  const schedule = scheduleOfDraft(draft);
  const same =
    draft.kind === "mail"
      ? normalizedMailKey(schedule) === normalizedMailKey(job.schedule)
      : scheduleKeyOf(schedule) === scheduleKeyOf(job.schedule);
  if (!same) {
    patch.schedule = schedule;
  }
  if (draft.kind === "mail") {
    const verify = verifyScheduleOfDraft(draft);
    if (normalizedMailKey(verify) !== normalizedMailKey(job.verifySchedule)) {
      patch.verifySchedule = verify;
    }
    if (draft.retentionPolicyId !== job.retention.policyId) {
      patch.retentionPolicyId = draft.retentionPolicyId;
    }
    if (draft.enabled !== job.enabled) {
      patch.enabled = draft.enabled;
    }
    if (draft.archive !== job.archive) {
      patch.archive = draft.archive;
    }
  } else {
    const settings = settingsOfDraft(draft.settings);
    if (stableSettingsKey(settings) !== stableSettingsKey(job.settings)) {
      patch.settings = settings;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Whether the scope differs from what the server holds (the mode or the explicit members). */
export function scopeChanged(
  job: Pick<BackupJob, "scopeMode">,
  members: readonly JobMember[],
  draft: JobDraft,
): boolean {
  if (draft.scopeMode !== job.scopeMode) {
    return true;
  }
  if (draft.scopeMode === "all") {
    return false;
  }
  const held = members
    .filter((member) => member.explicit)
    .map((member) => member.targetId)
    .sort();
  const wanted = draft.selected.map((member) => member.id).sort();
  return held.length !== wanted.length || held.some((id, index) => id !== wanted[index]);
}

// --- Overrides of one member -----------------------------------------------------------------

export const OVERRIDE_GROUPS = [
  "schedule",
  "verify",
  "folders",
  "exclusions",
  "bandwidth",
  "hooks",
  "retention",
] as const;
export type OverrideGroup = (typeof OVERRIDE_GROUPS)[number];

/** The groups a member of this kind can do differently. */
export function overrideGroupsOf(kind: JobKind): readonly OverrideGroup[] {
  return kind === "mail"
    ? ["schedule", "verify"]
    : ["schedule", "folders", "exclusions", "bandwidth", "hooks", "retention"];
}

/** The overrides editor: a switch per group and the values the group shows while it is on. */
export interface OverridesDraft {
  kind: JobKind;
  on: Record<OverrideGroup, boolean>;
  cadence: CadenceDraft;
  verifyCadence: CadenceDraft;
  endpointSchedule: EndpointScheduleDraft;
  settings: SettingsDraft;
}

function has(overrides: JobMemberOverrides, key: keyof JobMemberOverrides): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] !== undefined;
}

/** The state of the overrides editor for a member: what it does differently is on, the rest starts as the job's value. */
export function overridesDraftOf(
  kind: JobKind,
  member: JobMember,
  job: Pick<BackupJob, "schedule" | "verifySchedule" | "settings" | "retention">,
  defaults: JobDefaults | undefined,
): OverridesDraft {
  const overrides = member.overrides;
  const zone = defaults?.timeZone ?? job.schedule?.timeZone ?? FALLBACK_TIME_ZONE;
  const effective = member.effective;
  return {
    kind,
    on: {
      schedule: has(overrides, "schedule"),
      verify: has(overrides, "verifySchedule"),
      folders: has(overrides, "paths"),
      exclusions: has(overrides, "excludes") || has(overrides, "excludeLargerThanGib"),
      bandwidth:
        Object.prototype.hasOwnProperty.call(overrides, "bandwidthKbps") ||
        has(overrides, "bandwidthWindows"),
      hooks: has(overrides, "hooks"),
      retention: has(overrides, "retention"),
    },
    cadence: cadenceDraftOfSchedule(kind === "mail" ? effective.schedule : null, null, zone),
    verifyCadence: cadenceDraftOfSchedule(
      effective.verifySchedule,
      defaults?.verifySchedule ?? job.verifySchedule,
      zone,
    ),
    endpointSchedule: endpointScheduleDraftOf(
      kind === "endpoint" ? effective.schedule : null,
      job.schedule,
      zone,
    ),
    settings: settingsDraftOf(
      effective.settings,
      job.retention.keep ?? defaults?.endpointRetention,
    ),
  };
}

/** The parts of the settings an overrides draft has switched on. */
export function partsOfOverrides(draft: OverridesDraft): SettingsParts {
  return {
    folders: draft.on.folders,
    exclusions: draft.on.exclusions,
    bandwidth: draft.on.bandwidth,
    hooks: draft.on.hooks,
    retention: draft.on.retention,
  };
}

export interface OverridesProblems {
  cadence?: boolean;
  verifyCadence?: boolean;
  endpointSchedule?: Partial<Record<EndpointScheduleField, FormProblem>>;
  settings?: SettingsProblems;
}

export function checkOverrides(draft: OverridesDraft): OverridesProblems {
  const problems: OverridesProblems = {};
  if (draft.kind === "mail") {
    if (draft.on.schedule && !checkCadence(draft.cadence).ok) problems.cadence = true;
    if (draft.on.verify && !checkCadence(draft.verifyCadence).ok) problems.verifyCadence = true;
    return problems;
  }
  if (draft.on.schedule) {
    const schedule = checkEndpointSchedule(draft.endpointSchedule);
    if (hasProblems(schedule)) problems.endpointSchedule = schedule;
  }
  const settings = checkSettings(draft.settings, partsOfOverrides(draft));
  if (hasProblems(settings)) problems.settings = settings;
  return problems;
}

/** The overrides to send: only the groups that are on (an empty object clears them all). */
export function overridesOfDraft(draft: OverridesDraft): JobMemberOverrides {
  const overrides: JobMemberOverrides = {};
  if (draft.kind === "mail") {
    if (draft.on.schedule) {
      const schedule = mailScheduleOf(draft.cadence);
      if (schedule) overrides.schedule = schedule;
    }
    if (draft.on.verify) {
      const schedule = mailScheduleOf(draft.verifyCadence);
      if (schedule) overrides.verifySchedule = schedule;
    }
    return overrides;
  }
  const settings = settingsOfDraft(draft.settings);
  if (draft.on.schedule) overrides.schedule = jobScheduleOfEndpointDraft(draft.endpointSchedule);
  if (draft.on.folders && settings.paths) overrides.paths = settings.paths;
  if (draft.on.exclusions) {
    overrides.excludes = settings.excludes ?? [];
    overrides.excludeLargerThanGib = settings.excludeLargerThanGib ?? null;
  }
  if (draft.on.bandwidth) {
    // The limit and its windows are one setting: a member that has its own states both ("no windows" as []).
    overrides.bandwidthKbps = settings.bandwidthKbps ?? null;
    overrides.bandwidthWindows = settings.bandwidthWindows ?? [];
  }
  if (draft.on.hooks) overrides.hooks = settings.hooks ?? {};
  if (draft.on.retention) overrides.retention = retentionOf(draft.settings);
  return overrides;
}

/** Which groups of a member's overrides are set, in the order the editor lists them. */
export function overrideGroupsSet(overrides: JobMemberOverrides): OverrideGroup[] {
  const groups: OverrideGroup[] = [];
  if (has(overrides, "schedule")) groups.push("schedule");
  if (has(overrides, "verifySchedule")) groups.push("verify");
  if (has(overrides, "paths")) groups.push("folders");
  if (has(overrides, "excludes") || has(overrides, "excludeLargerThanGib"))
    groups.push("exclusions");
  if (
    Object.prototype.hasOwnProperty.call(overrides, "bandwidthKbps") ||
    has(overrides, "bandwidthWindows")
  ) {
    groups.push("bandwidth");
  }
  if (has(overrides, "hooks")) groups.push("hooks");
  if (has(overrides, "retention")) groups.push("retention");
  return groups;
}
