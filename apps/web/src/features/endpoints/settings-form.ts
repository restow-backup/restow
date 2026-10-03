import {
  type WindowDraft,
  checkWindowDrafts,
  windowDraftsOf,
  windowsKey,
  windowsOfDrafts,
} from "@/features/backup-jobs/bandwidth-windows";

import {
  type EndpointDetail,
  type EndpointSchedule,
  HOOK_SCRIPT_NAME,
  type HookPolicy,
  LIMITS,
  type Retention,
  type ScheduleKind,
  type UpdateEndpointInput,
} from "./api.js";
import { hasControlCharacters, isAbsolutePath } from "./presenters.js";

/**
 * The settings form as data: a draft the fields edit, the checks that mirror
 * the API's schemas (apps/api .../endpoints/schemas.ts), and the PATCH body
 * that holds only what the admin changed. A settings change is versioned on
 * the server (the agent fetches it with its next contact), so an unchanged
 * form must send nothing.
 */

export interface SettingsDraft {
  displayName: string;
  /** One row per backup path; blank rows are dropped. */
  paths: string[];
  /** One pattern per line. */
  excludes: string;
  scheduleKind: ScheduleKind;
  timeOfDay: string;
  timeZone: string;
  /** Minutes: the interval, or the least time between two backups on connect. Text, so it can be empty while typing. */
  intervalMinutes: string;
  preHook: string;
  postHook: string;
  /** Kilobits per second (the agent's unit); empty means unlimited. */
  bandwidthKbps: string;
  /** The time windows of the limit, one row each, read in the zone of the schedule. */
  bandwidthWindows: WindowDraft[];
  onlyOnAcPower: boolean;
  keepDaily: string;
  keepWeekly: string;
  keepMonthly: string;
  staleAfterHours: string;
  staleAfterDays: string;
  /** GiB; empty means the installation's default. */
  quotaGib: string;
}

/** The fields an error can belong to (the message key is `settings.errors.<code>`). */
export type DraftField =
  | "displayName"
  | "paths"
  | "excludes"
  | "timeOfDay"
  | "timeZone"
  | "intervalMinutes"
  | "preHook"
  | "postHook"
  | "bandwidthKbps"
  | "bandwidthWindows"
  | "keepDaily"
  | "keepWeekly"
  | "keepMonthly"
  | "staleAfterHours"
  | "staleAfterDays"
  | "quotaGib";

export interface DraftProblem {
  code:
    | "tooLong"
    | "controlCharacters"
    | "notAbsolute"
    | "noPaths"
    | "tooManyPaths"
    | "tooManyExcludes"
    | "timeOfDay"
    | "required"
    | "integer"
    | "range"
    | "notScriptName"
    | "windows";
  /** Values for the message: limits, the offending line. */
  values?: Record<string, string | number>;
}

export type DraftProblems = Partial<Record<DraftField, DraftProblem>>;

/** The defaults the server applies, shown next to the fields (docs/AGENT.md). */
export const DEFAULTS = {
  serverSchedule: { kind: "daily", timeOfDay: "22:00" },
  clientSchedule: { kind: "on_connect", intervalMinutes: 240 },
  retention: { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
  staleAfterHours: 2,
  staleAfterDays: 7,
} as const;

const FALLBACK_ZONE = "UTC";

export function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function numberText(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

export function draftFromDetail(
  detail: Pick<EndpointDetail, "displayName" | "config" | "settings" | "profile">,
  browserZone: string = FALLBACK_ZONE,
): SettingsDraft {
  const { config, settings } = detail;
  return {
    displayName: detail.displayName ?? "",
    paths: [...config.paths],
    excludes: config.excludes.join("\n"),
    scheduleKind: config.schedule.kind,
    timeOfDay: config.schedule.timeOfDay ?? DEFAULTS.serverSchedule.timeOfDay,
    timeZone: config.schedule.timeZone || browserZone,
    intervalMinutes: numberText(config.schedule.intervalMinutes),
    preHook: config.hooks.pre ?? "",
    postHook: config.hooks.post ?? "",
    bandwidthKbps: numberText(config.bandwidthKbps),
    bandwidthWindows: windowDraftsOf(config.bandwidthWindows),
    onlyOnAcPower: config.onlyOnAcPower,
    keepDaily: String(settings.retention.keepDaily),
    keepWeekly: String(settings.retention.keepWeekly),
    keepMonthly: String(settings.retention.keepMonthly),
    staleAfterHours: String(settings.staleAfterHours),
    staleAfterDays: String(settings.staleAfterDays),
    quotaGib: numberText(settings.quotaGib),
  };
}

/** Parse a whole number from a text field; `null` when it is not one. */
function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

function rangeProblem(
  text: string,
  min: number,
  max: number,
  { optional = false }: { optional?: boolean } = {},
): DraftProblem | null {
  if (text.trim() === "") {
    return optional ? null : { code: "required" };
  }
  const value = wholeNumber(text);
  if (value === null) {
    return { code: "integer" };
  }
  return value < min || value > max ? { code: "range", values: { min, max } } : null;
}

/** Everything the API would refuse, found before the request. */
export function checkDraft(
  draft: SettingsDraft,
  profile: "server" | "client",
  hookPolicy: HookPolicy | null = null,
): DraftProblems {
  const problems: DraftProblems = {};

  if (draft.displayName.trim().length > LIMITS.displayName) {
    problems.displayName = { code: "tooLong", values: { max: LIMITS.displayName } };
  }

  const paths = draft.paths.map((path) => path.trim()).filter(Boolean);
  if (paths.length === 0) {
    problems.paths = { code: "noPaths" };
  } else if (paths.length > LIMITS.backupPaths) {
    problems.paths = { code: "tooManyPaths", values: { max: LIMITS.backupPaths } };
  } else {
    for (const path of paths) {
      if (hasControlCharacters(path)) {
        problems.paths = { code: "controlCharacters", values: { value: path } };
      } else if (!isAbsolutePath(path)) {
        problems.paths = { code: "notAbsolute", values: { value: path } };
      } else if (path.length > LIMITS.pathLength) {
        problems.paths = { code: "tooLong", values: { max: LIMITS.pathLength } };
      }
      if (problems.paths) {
        break;
      }
    }
  }

  const excludes = linesOf(draft.excludes);
  if (excludes.length > LIMITS.excludes) {
    problems.excludes = { code: "tooManyExcludes", values: { max: LIMITS.excludes } };
  } else {
    for (const line of excludes) {
      if (hasControlCharacters(line)) {
        problems.excludes = { code: "controlCharacters", values: { value: line } };
        break;
      }
      if (line.length > LIMITS.excludeLength) {
        problems.excludes = { code: "tooLong", values: { max: LIMITS.excludeLength } };
        break;
      }
    }
  }

  if (draft.scheduleKind === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.timeOfDay)) {
    problems.timeOfDay = { code: "timeOfDay" };
  }
  if (draft.timeZone.trim() === "") {
    problems.timeZone = { code: "required" };
  }
  if (draft.scheduleKind === "interval") {
    const problem = rangeProblem(
      draft.intervalMinutes,
      LIMITS.intervalMinMinutes,
      LIMITS.intervalMaxMinutes,
    );
    if (problem) {
      problems.intervalMinutes = problem;
    }
  } else if (draft.scheduleKind === "on_connect") {
    const problem = rangeProblem(
      draft.intervalMinutes,
      LIMITS.intervalMinMinutes,
      LIMITS.intervalMaxMinutes,
      { optional: true },
    );
    if (problem) {
      problems.intervalMinutes = problem;
    }
  }

  if (draft.preHook.length > LIMITS.hookLength) {
    problems.preHook = { code: "tooLong", values: { max: LIMITS.hookLength } };
  }
  if (draft.postHook.length > LIMITS.hookLength) {
    problems.postHook = { code: "tooLong", values: { max: LIMITS.hookLength } };
  }
  // A machine that only runs its own scripts takes a script name, not a command.
  if (hookPolicy === "scripts") {
    for (const key of ["preHook", "postHook"] as const) {
      const value = draft[key].trim();
      if (value !== "" && !HOOK_SCRIPT_NAME.test(value)) {
        problems[key] = { code: "notScriptName" };
      }
    }
  }

  const bandwidth = rangeProblem(draft.bandwidthKbps, 1, LIMITS.bandwidthMaxKbps, {
    optional: true,
  });
  if (bandwidth) {
    problems.bandwidthKbps = bandwidth;
  }
  // What is wrong in a row is said at the row (`checkWindowDrafts`); this only blocks the save.
  if (checkWindowDrafts(draft.bandwidthWindows).invalid) {
    problems.bandwidthWindows = { code: "windows" };
  }

  const retention: [DraftField, string, number][] = [
    ["keepDaily", draft.keepDaily, LIMITS.keepDaily],
    ["keepWeekly", draft.keepWeekly, LIMITS.keepWeekly],
    ["keepMonthly", draft.keepMonthly, LIMITS.keepMonthly],
  ];
  for (const [field, text, max] of retention) {
    const problem = rangeProblem(text, 0, max);
    if (problem) {
      problems[field] = problem;
    }
  }

  if (profile === "server") {
    const problem = rangeProblem(draft.staleAfterHours, 1, LIMITS.staleHoursMax);
    if (problem) {
      problems.staleAfterHours = problem;
    }
  } else {
    const problem = rangeProblem(draft.staleAfterDays, 1, LIMITS.staleDaysMax);
    if (problem) {
      problems.staleAfterDays = problem;
    }
  }

  const quota = rangeProblem(draft.quotaGib, 1, LIMITS.quotaGibMax, { optional: true });
  if (quota) {
    problems.quotaGib = quota;
  }
  return problems;
}

export function hasProblems(problems: DraftProblems): boolean {
  return Object.keys(problems).length > 0;
}

/** The schedule the draft describes, with only the fields its kind uses. */
export function scheduleOf(draft: SettingsDraft): EndpointSchedule {
  const timeZone = draft.timeZone.trim();
  switch (draft.scheduleKind) {
    case "none":
      return { kind: "none", timeZone };
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

/** The current schedule reduced to the fields its kind uses, so both sides compare fairly. */
function normalizedSchedule(schedule: EndpointSchedule): EndpointSchedule {
  switch (schedule.kind) {
    case "none":
      return { kind: "none", timeZone: schedule.timeZone };
    case "daily":
      return { kind: "daily", timeOfDay: schedule.timeOfDay ?? "", timeZone: schedule.timeZone };
    case "interval":
      return {
        kind: "interval",
        intervalMinutes: schedule.intervalMinutes ?? 0,
        timeZone: schedule.timeZone,
      };
    default:
      return schedule.intervalMinutes === undefined
        ? { kind: "on_connect", timeZone: schedule.timeZone }
        : {
            kind: "on_connect",
            intervalMinutes: schedule.intervalMinutes,
            timeZone: schedule.timeZone,
          };
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function retentionOf(draft: SettingsDraft): Retention {
  return {
    keepDaily: wholeNumber(draft.keepDaily) ?? 0,
    keepWeekly: wholeNumber(draft.keepWeekly) ?? 0,
    keepMonthly: wholeNumber(draft.keepMonthly) ?? 0,
  };
}

/**
 * The PATCH body with only the parts that differ from what the server holds,
 * or `null` when nothing changed. Hooks are replaced as a pair by the API, so
 * a changed hook sends both. Call `checkDraft` first: this assumes valid input.
 */
export function buildPatch(
  detail: Pick<EndpointDetail, "displayName" | "config" | "settings" | "profile">,
  draft: SettingsDraft,
): UpdateEndpointInput | null {
  const patch: UpdateEndpointInput = {};
  const { config, settings } = detail;

  const name = draft.displayName.trim();
  if (name !== (detail.displayName?.trim() ?? "")) {
    patch.displayName = name === "" ? null : name;
  }

  const changed: NonNullable<UpdateEndpointInput["config"]> = {};

  const schedule = scheduleOf(draft);
  if (JSON.stringify(schedule) !== JSON.stringify(normalizedSchedule(config.schedule))) {
    changed.schedule = schedule;
  }

  const paths = draft.paths.map((path) => path.trim()).filter(Boolean);
  if (!sameList(paths, config.paths)) {
    changed.paths = paths;
  }

  const excludes = linesOf(draft.excludes);
  if (!sameList(excludes, config.excludes)) {
    changed.excludes = excludes;
  }

  const pre = draft.preHook.trim();
  const post = draft.postHook.trim();
  if (pre !== (config.hooks.pre ?? "").trim() || post !== (config.hooks.post ?? "").trim()) {
    changed.hooks = {
      ...(pre ? { pre } : {}),
      ...(post ? { post } : {}),
    };
  }

  const bandwidth = draft.bandwidthKbps.trim() === "" ? null : wholeNumber(draft.bandwidthKbps);
  if (bandwidth !== config.bandwidthKbps) {
    changed.bandwidthKbps = bandwidth;
  }

  // Compared by meaning (order of the week, each day once); none at all is sent as null.
  const windows = windowsOfDrafts(draft.bandwidthWindows);
  if (windowsKey(windows) !== windowsKey(config.bandwidthWindows)) {
    changed.bandwidthWindows = windows.length > 0 ? windows : null;
  }

  if (draft.onlyOnAcPower !== config.onlyOnAcPower) {
    changed.onlyOnAcPower = draft.onlyOnAcPower;
  }

  if (Object.keys(changed).length > 0) {
    patch.config = changed;
  }

  const changedSettings: NonNullable<UpdateEndpointInput["settings"]> = {};
  const retention = retentionOf(draft);
  if (
    retention.keepDaily !== settings.retention.keepDaily ||
    retention.keepWeekly !== settings.retention.keepWeekly ||
    retention.keepMonthly !== settings.retention.keepMonthly
  ) {
    changedSettings.retention = retention;
  }
  if (detail.profile === "server") {
    const hours = wholeNumber(draft.staleAfterHours);
    if (hours !== null && hours !== settings.staleAfterHours) {
      changedSettings.staleAfterHours = hours;
    }
  } else {
    const days = wholeNumber(draft.staleAfterDays);
    if (days !== null && days !== settings.staleAfterDays) {
      changedSettings.staleAfterDays = days;
    }
  }
  const quotaGib = draft.quotaGib.trim() === "" ? null : wholeNumber(draft.quotaGib);
  if (quotaGib !== settings.quotaGib) {
    changedSettings.quotaGib = quotaGib;
  }
  if (Object.keys(changedSettings).length > 0) {
    patch.settings = changedSettings;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/** Which sections of the form differ from the server (for the "unsaved changes" hint). */
export function changedSections(
  detail: Pick<EndpointDetail, "displayName" | "config" | "settings" | "profile">,
  draft: SettingsDraft,
): string[] {
  const patch = buildPatch(detail, draft);
  if (!patch) {
    return [];
  }
  const sections: string[] = [];
  if (patch.displayName !== undefined) sections.push("displayName");
  for (const key of Object.keys(patch.config ?? {})) sections.push(key);
  for (const key of Object.keys(patch.settings ?? {})) sections.push(key);
  return sections;
}
