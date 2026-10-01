import type { TFunction } from "i18next";
import {
  Archive,
  DatabaseBackup,
  Hourglass,
  type LucideIcon,
  ScanSearch,
  ShieldCheck,
  UsersRound,
} from "lucide-react";

import type { StatusTone } from "@/components/kit";
import { ApiError } from "@/lib/api";

import {
  type JobStatus,
  OBJECT_SCOPED_KINDS,
  type OfferedKind,
  type ScheduleInput,
  type ScheduleItem,
  type ScheduleKind,
  type SchedulePatch,
} from "./api.js";
import {
  MAX_PRESET_DAY_OF_MONTH,
  type PresetType,
  type StoredCadence,
  type Weekday,
  cadenceFromPreset,
  presetFromCadence,
} from "./presets.js";

/**
 * Pure presentation and form logic of the schedules page: icons and tones,
 * cadences in words, whether backups and verification are covered, and the
 * form draft with its conversion to API requests. Kept free of React so it is
 * unit-tested directly.
 */

export const KIND_ICON: Readonly<Record<ScheduleKind, LucideIcon>> = {
  backup: DatabaseBackup,
  verify: ShieldCheck,
  scrub: ScanSearch,
  directory: UsersRound,
  retention: Hourglass,
  archive: Archive,
};

/** A run that completed is neutral: green is for a passed restore check, not for a job that ended. */
export const JOB_STATUS_TONE: Readonly<Record<JobStatus, StatusTone>> = {
  queued: "muted",
  active: "info",
  completed: "neutral",
  failed: "destructive",
  cancelled: "warning",
};

/** Shortest and longest interval the API accepts (mirrors @restow/core). */
export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 31 * 24 * 60;

/** A zone every browser knows, used when the browser reports none. */
export const FALLBACK_TIME_ZONE = "Europe/Berlin";

// --- Cadence in words ----------------------------------------------------------

/** "04:30" / "4:30 AM" for a wall-clock time, in the UI language. */
export function formatClock(hour: number, minute: number, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
}

/** 2023-01-01 was a Sunday: day `d` of that week names weekday `d`. */
function weekdayName(day: Weekday, language: string, width: "long" | "short"): string {
  return new Intl.DateTimeFormat(language, { weekday: width, timeZone: "UTC" }).format(
    new Date(Date.UTC(2023, 0, 1 + day)),
  );
}

/** Weekdays in reading order, Monday first: [0, 6, 1] → [1, 6, 0]. */
export function mondayFirst(days: readonly Weekday[]): Weekday[] {
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
}

/** The seven weekdays Monday first, for the day picker. */
export const WEEK: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];

export function weekdayLabel(day: Weekday, language: string): string {
  return weekdayName(day, language, "short");
}

/** "Monday, Wednesday and Friday" in the UI language. */
export function formatDays(days: readonly Weekday[], language: string): string {
  const names = mondayFirst(days).map((day) => weekdayName(day, language, "long"));
  return new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(names);
}

const WORKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5];

/** How often a schedule runs, in words; custom expressions are shown as written. */
export function describeCadence(cadence: StoredCadence, t: TFunction, language: string): string {
  const preset = presetFromCadence(cadence);
  switch (preset.type) {
    case "every_minutes":
      return t("cadence.everyMinutes", { count: preset.minutes });
    case "every_hours":
      return t("cadence.everyHours", { count: preset.hours });
    case "daily":
      return t("cadence.daily", { time: formatClock(preset.hour, preset.minute, language) });
    case "weekly": {
      const time = formatClock(preset.hour, preset.minute, language);
      const workdays =
        preset.days.length === WORKDAYS.length &&
        WORKDAYS.every((day) => preset.days.includes(day));
      return workdays
        ? t("cadence.workdays", { time })
        : t("cadence.weekly", { days: formatDays(preset.days, language), time });
    }
    case "monthly":
      return t("cadence.monthly", {
        day: preset.dayOfMonth,
        time: formatClock(preset.hour, preset.minute, language),
      });
    case "custom":
      return t("cadence.custom", { cron: preset.cron });
    default:
      return "";
  }
}

/** Whether the cadence's time zone matters for reading it (cron runs at local times). */
export function usesTimeZone(cadence: StoredCadence): boolean {
  return cadence.cron !== null;
}

/**
 * What a schedule covers: one object, every protected object or the whole
 * tenant. Another person's object, which tenant users see by its kind only,
 * says so rather than showing a blank.
 */
export function describeScope(item: Pick<ScheduleItem, "kind" | "protectedObject">, t: TFunction) {
  if (item.protectedObject) {
    return item.protectedObject.name ?? t(`scope.withheld.${item.protectedObject.kind}`);
  }
  return OBJECT_SCOPED_KINDS.includes(item.kind) ? t("scope.allObjects") : t("scope.tenant");
}

// --- Coverage (the honest warnings) --------------------------------------------

export type CoverageState = "active" | "paused" | "missing";

export interface Coverage {
  state: CoverageState;
  /** A tenant-wide schedule of the kind that is switched off (to switch it on again). */
  paused: ScheduleItem | null;
}

/**
 * Whether a tenant-wide schedule of `kind` runs: `active` when one is on,
 * `paused` when they all are off, `missing` when there is none. A schedule
 * narrowed to one object does not cover the others.
 */
export function coverageOf(items: readonly ScheduleItem[], kind: "backup" | "verify"): Coverage {
  const tenantWide = items.filter((item) => item.kind === kind && item.protectedObject === null);
  if (tenantWide.some((item) => item.enabled)) {
    return { state: "active", paused: null };
  }
  const paused = tenantWide[0] ?? null;
  return { state: paused ? "paused" : "missing", paused };
}

/** Switching off a backup or verify schedule is asked about first. */
export function needsDisableConfirmation(item: Pick<ScheduleItem, "kind" | "enabled">): boolean {
  return item.enabled && (item.kind === "backup" || item.kind === "verify");
}

// --- Form draft ------------------------------------------------------------------

export type ScopeMode = "all" | "object";

/** The schedule form's state; numbers stay text while they are being typed. */
export interface ScheduleDraft {
  kind: OfferedKind;
  presetType: PresetType;
  minutes: string;
  hours: string;
  /** "HH:MM" from the time input. */
  time: string;
  days: Weekday[];
  dayOfMonth: string;
  cron: string;
  timezone: string;
  scope: ScopeMode;
  object: { id: string; name: string } | null;
  enabled: boolean;
}

export type DraftField = "minutes" | "hours" | "time" | "days" | "dayOfMonth" | "cron" | "object";

export type DraftCheck =
  | { ok: true; cadence: StoredCadence }
  | { ok: false; field: DraftField; reason: "required" | "range" };

const pad = (value: number) => String(value).padStart(2, "0");

/** A new schedule: a backup every 8 hours of every object, in the given zone. */
export function newDraft(timezone: string): ScheduleDraft {
  return {
    kind: "backup",
    presetType: "every_hours",
    minutes: "60",
    hours: "8",
    time: "03:00",
    days: [0],
    dayOfMonth: "1",
    cron: "",
    timezone,
    scope: "all",
    object: null,
    enabled: true,
  };
}

/** The form state of an existing schedule. */
export function draftFromSchedule(item: ScheduleItem): ScheduleDraft {
  const draft: ScheduleDraft = {
    ...newDraft(item.timezone),
    kind: item.kind === "archive" ? "backup" : item.kind,
    cron: item.cron ?? "",
    scope: item.protectedObject ? "object" : "all",
    // Administrators, the only ones who edit, always receive the object's id and name.
    object:
      item.protectedObject?.id != null
        ? { id: item.protectedObject.id, name: item.protectedObject.name }
        : null,
    enabled: item.enabled,
  };
  const preset = presetFromCadence(item);
  switch (preset.type) {
    case "every_minutes":
      return { ...draft, presetType: preset.type, minutes: String(preset.minutes) };
    case "every_hours":
      return { ...draft, presetType: preset.type, hours: String(preset.hours) };
    case "daily":
      return {
        ...draft,
        presetType: preset.type,
        time: `${pad(preset.hour)}:${pad(preset.minute)}`,
      };
    case "weekly":
      return {
        ...draft,
        presetType: preset.type,
        days: [...preset.days],
        time: `${pad(preset.hour)}:${pad(preset.minute)}`,
      };
    case "monthly":
      return {
        ...draft,
        presetType: preset.type,
        dayOfMonth: String(preset.dayOfMonth),
        time: `${pad(preset.hour)}:${pad(preset.minute)}`,
      };
    default:
      return { ...draft, presetType: "custom", cron: preset.cron };
  }
}

function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

function parseTime(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/**
 * The cadence the draft describes, or the first field to correct. Only what
 * the form can know is checked here; the API judges the cron expression and
 * the zone (and the live preview shows its verdict while typing).
 */
export function checkDraft(draft: ScheduleDraft): DraftCheck {
  const fail = (field: DraftField, reason: "required" | "range"): DraftCheck => ({
    ok: false,
    field,
    reason,
  });
  if (draft.scope === "object" && OBJECT_SCOPED_KINDS.includes(draft.kind) && !draft.object) {
    return fail("object", "required");
  }
  switch (draft.presetType) {
    case "every_minutes": {
      const minutes = wholeNumber(draft.minutes);
      if (minutes === null) return fail("minutes", "required");
      if (minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
        return fail("minutes", "range");
      }
      return { ok: true, cadence: cadenceFromPreset({ type: "every_minutes", minutes }) };
    }
    case "every_hours": {
      const hours = wholeNumber(draft.hours);
      if (hours === null) return fail("hours", "required");
      if (hours < 1 || hours * 60 > MAX_INTERVAL_MINUTES) return fail("hours", "range");
      return { ok: true, cadence: cadenceFromPreset({ type: "every_hours", hours }) };
    }
    case "custom": {
      const cron = draft.cron.trim();
      return cron
        ? { ok: true, cadence: { intervalMinutes: null, cron } }
        : fail("cron", "required");
    }
    default:
      break;
  }
  const time = parseTime(draft.time);
  if (!time) {
    return fail("time", "required");
  }
  if (draft.presetType === "daily") {
    return { ok: true, cadence: cadenceFromPreset({ type: "daily", ...time }) };
  }
  if (draft.presetType === "weekly") {
    if (draft.days.length === 0) return fail("days", "required");
    return { ok: true, cadence: cadenceFromPreset({ type: "weekly", days: draft.days, ...time }) };
  }
  const dayOfMonth = wholeNumber(draft.dayOfMonth);
  if (dayOfMonth === null) return fail("dayOfMonth", "required");
  if (dayOfMonth < 1 || dayOfMonth > MAX_PRESET_DAY_OF_MONTH) return fail("dayOfMonth", "range");
  return { ok: true, cadence: cadenceFromPreset({ type: "monthly", dayOfMonth, ...time }) };
}

function scopeOf(draft: ScheduleDraft): string | null {
  return draft.scope === "object" && OBJECT_SCOPED_KINDS.includes(draft.kind)
    ? (draft.object?.id ?? null)
    : null;
}

/** The create request of a valid draft. */
export function inputFromDraft(draft: ScheduleDraft, cadence: StoredCadence): ScheduleInput {
  return {
    kind: draft.kind,
    protectedObjectId: scopeOf(draft),
    intervalMinutes: cadence.intervalMinutes,
    cron: cadence.cron,
    timezone: draft.timezone,
    enabled: draft.enabled,
  };
}

/** Only what changed, for PATCH; an empty object when nothing did. */
export function patchFromDraft(
  item: ScheduleItem,
  draft: ScheduleDraft,
  cadence: StoredCadence,
): SchedulePatch {
  const patch: SchedulePatch = {};
  if (cadence.intervalMinutes !== item.intervalMinutes || cadence.cron !== item.cron) {
    patch.intervalMinutes = cadence.intervalMinutes;
    patch.cron = cadence.cron;
  }
  if (draft.timezone !== item.timezone) {
    patch.timezone = draft.timezone;
  }
  const protectedObjectId = scopeOf(draft);
  if (protectedObjectId !== (item.protectedObject?.id ?? null)) {
    patch.protectedObjectId = protectedObjectId;
  }
  if (draft.enabled !== item.enabled) {
    patch.enabled = draft.enabled;
  }
  return patch;
}

const MINUTE_MS = 60_000;

/**
 * The next runs of an interval schedule, counted from its last run the way the
 * API does (a schedule that never ran, or is overdue, runs at once). Cron
 * cadences are previewed by the API instead; intervals need no zone rules.
 */
export function intervalRuns(
  intervalMinutes: number,
  lastRunAt: string | null,
  now: number,
  count = 5,
): Date[] {
  const last = lastRunAt === null ? Number.NaN : Date.parse(lastRunAt);
  const first = Number.isNaN(last) ? now : Math.max(now, last + intervalMinutes * MINUTE_MS);
  return Array.from(
    { length: count },
    (_, index) => new Date(first + index * intervalMinutes * MINUTE_MS),
  );
}

/** "Sun, 8 Mar, 03:00 CET": a run in the zone it is scheduled in (the browser's when omitted). */
export function formatRun(instant: Date, language: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(language, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
    timeZoneName: timeZone ? "short" : undefined,
  }).format(instant);
}

// --- Problems from the API --------------------------------------------------------

const PROBLEM_CODES = new Set([
  "cadence_missing",
  "cadence_ambiguous",
  "interval_not_integer",
  "interval_out_of_range",
  "cron_invalid",
  "cron_never_matches",
  "cron_too_frequent",
  "timezone_unknown",
  "scope_not_supported",
  "object_not_found",
]);

export interface FieldProblem {
  /** The request field the API named (`cron`, `timezone`, `intervalMinutes`, `protectedObjectId`). */
  field: string;
  /** Translation key (schedules namespace) of the reason. */
  key: string;
}

/** The field and translated reason of a schedule the API refused, or null for other errors. */
export function fieldProblem(error: unknown): FieldProblem | null {
  if (!(error instanceof ApiError) || error.status !== 422 || !error.problem) {
    return null;
  }
  const field = typeof error.problem.field === "string" ? error.problem.field : null;
  const code = typeof error.problem.code === "string" ? error.problem.code : null;
  if (!field) {
    return null;
  }
  return { field, key: code && PROBLEM_CODES.has(code) ? `problems.${code}` : "problems.generic" };
}

// --- Time zones ---------------------------------------------------------------------

/** The browser's zone, the default for new schedules. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/** Every IANA zone the browser knows, the given ones first (without duplicates). */
export function timeZoneOptions(first: readonly string[]): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  const all = new Set<string>([...first.filter(Boolean), ...zones, "UTC"]);
  return [...all];
}

/**
 * When a schedule last did something: its own last firing, or the finish of
 * the newest job run on its behalf (restore checks the worker queues right
 * after a backup carry the verify schedule's id), whichever is later.
 */
export function lastActivityAt(
  schedule: Pick<ScheduleItem, "lastRunAt" | "lastJob">,
): string | null {
  const own = schedule.lastRunAt;
  const job = schedule.lastJob?.finishedAt ?? null;
  if (own === null || own === undefined) {
    return job;
  }
  if (job === null) {
    return own;
  }
  return Date.parse(job) > Date.parse(own) ? job : own;
}
