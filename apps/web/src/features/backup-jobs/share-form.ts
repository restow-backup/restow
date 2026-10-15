import {
  type BackupJob,
  type CreateBackupJobInput,
  type JobCandidate,
  type JobDefaults,
  type JobEndpointSettings,
  type JobMember,
  type JobRetention,
  type JobSchedule,
  LIMITS,
  type UpdateBackupJobInput,
} from "./api.js";
import {
  type WindowDraft,
  checkWindowDrafts,
  windowDraftsOf,
  windowsKey,
  windowsOfDrafts,
} from "./bandwidth-windows.js";
import type { FormProblem } from "./form.js";

/**
 * The editors of file share jobs and copy jobs as data (docs/FILESHARES.md 7.5, 12.5, 12.6): the
 * drafts the fields edit, the checks that mirror the API (apps/api backup-jobs/schemas.ts and
 * write.ts), and the requests. Pure, tested without a browser.
 */

/** "Skip temporary and system files" (7.5), as the API applies it; shown under the switch. */
export const SHARE_SYSTEM_FILE_PATTERNS: readonly string[] = [
  "~$*",
  "*.tmp",
  "Thumbs.db",
  "desktop.ini",
  ".DS_Store",
  "*.lck",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".snapshot",
  "~snapshot",
  "#recycle",
  "#snapshot",
  "@eaDir",
  ".@__thumb",
];

/** A share or copy job runs at most once an hour (7.5). */
export const SHARE_MIN_INTERVAL_HOURS = 1;
export const SHARE_MAX_INTERVAL_HOURS = 31 * 24;
const DEFAULT_RETENTION: JobRetention = { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 };

// --- Schedule ------------------------------------------------------------------------------

export type ShareScheduleKind = "daily" | "interval" | "cron";

export interface ShareScheduleDraft {
  kind: ShareScheduleKind;
  /** `HH:MM`. */
  timeOfDay: string;
  /** Whole hours, as typed. */
  intervalHours: string;
  cron: string;
  timeZone: string;
}

export function newShareScheduleDraft(zone: string, timeOfDay = "22:00"): ShareScheduleDraft {
  return { kind: "daily", timeOfDay, intervalHours: "24", cron: "", timeZone: zone };
}

const DAILY_CRON = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;

/** The form state of a stored schedule: a daily time comes back from its cron expression. */
export function shareScheduleDraftOf(
  schedule: JobSchedule | null | undefined,
  zone: string,
  fallbackTime = "22:00",
): ShareScheduleDraft {
  const base = newShareScheduleDraft(schedule?.timeZone || zone, fallbackTime);
  if (!schedule) return base;
  if (schedule.kind === "daily" && schedule.timeOfDay) {
    return { ...base, kind: "daily", timeOfDay: schedule.timeOfDay };
  }
  if (schedule.kind === "interval" && typeof schedule.intervalMinutes === "number") {
    return {
      ...base,
      kind: "interval",
      intervalHours: String(Math.max(1, Math.round(schedule.intervalMinutes / 60))),
    };
  }
  if (schedule.kind === "cron" && schedule.cron) {
    const daily = DAILY_CRON.exec(schedule.cron.trim().replace(/\s+/g, " "));
    if (daily) {
      const hour = Number(daily[2]);
      const minute = Number(daily[1]);
      if (hour < 24 && minute < 60) {
        return {
          ...base,
          kind: "daily",
          timeOfDay: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        };
      }
    }
    return { ...base, kind: "cron", cron: schedule.cron };
  }
  return base;
}

export type ShareScheduleProblems = Partial<
  Record<"timeOfDay" | "intervalHours" | "cron" | "timeZone", FormProblem>
>;

export function checkShareSchedule(draft: ShareScheduleDraft): ShareScheduleProblems {
  const problems: ShareScheduleProblems = {};
  if (draft.timeZone.trim() === "") problems.timeZone = { code: "required" };
  if (draft.kind === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.timeOfDay)) {
    problems.timeOfDay = { code: "timeOfDay" };
  }
  if (draft.kind === "interval") {
    const text = draft.intervalHours.trim();
    if (!/^\d+$/.test(text)) {
      problems.intervalHours = { code: text === "" ? "required" : "integer" };
    } else if (Number(text) < SHARE_MIN_INTERVAL_HOURS || Number(text) > SHARE_MAX_INTERVAL_HOURS) {
      problems.intervalHours = {
        code: "range",
        values: { min: SHARE_MIN_INTERVAL_HOURS, max: SHARE_MAX_INTERVAL_HOURS },
      };
    }
  }
  if (draft.kind === "cron" && draft.cron.trim().split(/\s+/).length !== 5) {
    problems.cron = { code: "cron" };
  }
  return problems;
}

export function shareScheduleOf(draft: ShareScheduleDraft): JobSchedule {
  const timeZone = draft.timeZone.trim();
  switch (draft.kind) {
    case "interval":
      return {
        kind: "interval",
        intervalMinutes: Number(draft.intervalHours.trim()) * 60,
        timeZone,
      };
    case "cron":
      return { kind: "cron", cron: draft.cron.trim().replace(/\s+/g, " "), timeZone };
    default:
      return { kind: "daily", timeOfDay: draft.timeOfDay, timeZone };
  }
}

/** A daily time as the cron expression the API stores, so a schedule that did not change is not sent. */
function scheduleKey(schedule: JobSchedule | null): string {
  if (!schedule) return "none";
  if (schedule.kind === "daily" && schedule.timeOfDay) {
    const [hour, minute] = schedule.timeOfDay.split(":").map(Number);
    return `cron:${minute} ${hour} * * *@${schedule.timeZone}`;
  }
  if (schedule.kind === "interval")
    return `interval:${schedule.intervalMinutes}@${schedule.timeZone}`;
  return `cron:${(schedule.cron ?? "").trim().replace(/\s+/g, " ")}@${schedule.timeZone}`;
}

// --- Share jobs ------------------------------------------------------------------------------

export interface ShareMemberDraft {
  id: string;
  name: string | null;
  detail: string | null;
  /** The job it belongs to now, when the person chose to move it here. */
  job: { id: string; name: string } | null;
  /** Folders relative to the share root; empty = everything. */
  includes: string[];
}

export interface ShareJobDraft {
  name: string;
  enabled: boolean;
  /** Off: the job runs when someone starts it. */
  scheduleOn: boolean;
  schedule: ShareScheduleDraft;
  members: ShareMemberDraft[];
  /** Own patterns, one per line. */
  excludes: string;
  systemFiles: boolean;
  fileTypes: string[];
  largerOn: boolean;
  largerGib: string;
  bandwidth: string;
  windows: WindowDraft[];
  readConcurrency: string;
  skipOffline: boolean;
  keepDaily: string;
  keepWeekly: string;
  keepMonthly: string;
}

export function newShareJobDraft(defaults: JobDefaults | undefined): ShareJobDraft {
  const zone = defaults?.timeZone ?? "Europe/Berlin";
  const retention = defaults?.settings.retention ?? DEFAULT_RETENTION;
  return {
    name: "",
    enabled: true,
    scheduleOn: true,
    schedule: shareScheduleDraftOf(defaults?.schedule, zone),
    members: [],
    excludes: "",
    systemFiles: true,
    fileTypes: [],
    largerOn: false,
    largerGib: "",
    bandwidth: "",
    windows: [],
    readConcurrency: "",
    skipOffline: true,
    keepDaily: String(retention.keepDaily),
    keepWeekly: String(retention.keepWeekly),
    keepMonthly: String(retention.keepMonthly),
  };
}

export function memberDraftOf(
  member: Pick<JobMember, "targetId" | "name" | "detail" | "overrides">,
): ShareMemberDraft {
  return {
    id: member.targetId,
    name: member.name,
    detail: member.detail,
    job: null,
    includes: [...(member.overrides.includes ?? [])],
  };
}

export function memberDraftOfCandidate(candidate: JobCandidate): ShareMemberDraft {
  return {
    id: candidate.targetId,
    name: candidate.name,
    detail: candidate.detail,
    job: candidate.job,
    includes: [],
  };
}

export function draftOfShareJob(job: BackupJob, members: readonly JobMember[]): ShareJobDraft {
  const s = job.settings ?? {};
  const retention = s.retention ?? job.retention.keep ?? DEFAULT_RETENTION;
  const zone = job.schedule?.timeZone ?? "Europe/Berlin";
  return {
    name: job.name,
    enabled: job.enabled,
    scheduleOn: job.schedule !== null,
    schedule: shareScheduleDraftOf(job.schedule, zone),
    members: members.map(memberDraftOf),
    excludes: (s.excludes ?? []).join("\n"),
    systemFiles: s.presets?.systemFiles !== false,
    fileTypes: [...(s.fileTypes?.exclude ?? [])],
    largerOn: typeof s.excludeLargerThanGib === "number",
    largerGib: typeof s.excludeLargerThanGib === "number" ? String(s.excludeLargerThanGib) : "",
    bandwidth: typeof s.bandwidthKbps === "number" ? String(s.bandwidthKbps) : "",
    windows: windowDraftsOf(s.bandwidthWindows),
    readConcurrency: typeof s.readConcurrency === "number" ? String(s.readConcurrency) : "",
    skipOffline: s.skipOffline !== false,
    keepDaily: String(retention.keepDaily),
    keepWeekly: String(retention.keepWeekly),
    keepMonthly: String(retention.keepMonthly),
  };
}

export interface ShareJobProblems {
  name?: FormProblem;
  schedule?: ShareScheduleProblems;
  excludes?: FormProblem;
  fileTypes?: FormProblem;
  larger?: FormProblem;
  bandwidth?: FormProblem;
  windows?: FormProblem;
  readConcurrency?: FormProblem;
  keepDaily?: FormProblem;
  keepWeekly?: FormProblem;
  keepMonthly?: FormProblem;
}

function wholeIn(text: string, min: number, max: number): FormProblem | null {
  const value = text.trim();
  if (value === "") return { code: "required" };
  if (!/^\d+$/.test(value)) return { code: "integer" };
  const number = Number(value);
  return number < min || number > max ? { code: "range", values: { min, max } } : null;
}

const EXTENSION = /^[A-Za-z0-9][A-Za-z0-9_+-]{0,31}$/;

export function excludeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A typed file type as the API keeps it (`.ISO` -> `ISO`, `*.bak` -> `bak`); null when invalid. */
export function cleanExtension(value: string): string | null {
  const clean = value.trim().replace(/^\*?\./, "");
  return EXTENSION.test(clean) ? clean : null;
}

export function checkShareJobDraft(draft: ShareJobDraft): ShareJobProblems {
  const problems: ShareJobProblems = {};
  const name = draft.name.trim();
  if (name === "") problems.name = { code: "nameRequired" };
  else if (name.length > LIMITS.name)
    problems.name = { code: "nameTooLong", values: { max: LIMITS.name } };
  if (draft.scheduleOn) {
    const schedule = checkShareSchedule(draft.schedule);
    if (Object.keys(schedule).length > 0) problems.schedule = schedule;
  }
  const lines = excludeLines(draft.excludes);
  if (lines.length > LIMITS.excludes) {
    problems.excludes = { code: "excludes.tooMany", values: { max: LIMITS.excludes } };
  } else if (lines.some((line) => line.length > LIMITS.excludeLength)) {
    problems.excludes = { code: "excludes.tooLong", values: { max: LIMITS.excludeLength } };
  }
  if (draft.fileTypes.some((ext) => cleanExtension(ext) === null)) {
    problems.fileTypes = { code: "fileType" };
  }
  if (draft.largerOn) {
    const value = Number(draft.largerGib.replace(",", "."));
    if (!(value > 0 && value <= LIMITS.excludeLargerThanGibMax)) {
      problems.larger = { code: "larger", values: { max: LIMITS.excludeLargerThanGibMax } };
    }
  }
  if (draft.bandwidth.trim() !== "") {
    const problem = wholeIn(draft.bandwidth, 1, LIMITS.bandwidthMaxKbps);
    if (problem) problems.bandwidth = problem;
  }
  if (checkWindowDrafts(draft.windows).invalid) problems.windows = { code: "windows.fix" };
  if (draft.readConcurrency.trim() !== "") {
    const problem = wholeIn(draft.readConcurrency, 1, 16);
    if (problem) problems.readConcurrency = problem;
  }
  const keep: [keyof ShareJobProblems, string, number][] = [
    ["keepDaily", draft.keepDaily, LIMITS.keepDaily],
    ["keepWeekly", draft.keepWeekly, LIMITS.keepWeekly],
    ["keepMonthly", draft.keepMonthly, LIMITS.keepMonthly],
  ];
  for (const [field, text, max] of keep) {
    const problem = wholeIn(text, 0, max);
    if (problem) (problems as Record<string, FormProblem>)[field] = problem;
  }
  return problems;
}

/** The settings a share job is saved with (the API replaces the whole object). */
export function shareSettingsOf(draft: ShareJobDraft): JobEndpointSettings {
  return {
    excludes: excludeLines(draft.excludes),
    presets: { systemFiles: draft.systemFiles },
    fileTypes: {
      exclude: draft.fileTypes
        .map((ext) => cleanExtension(ext))
        .filter((ext): ext is string => ext !== null),
    },
    excludeLargerThanGib: draft.largerOn ? Number(draft.largerGib.replace(",", ".")) : null,
    bandwidthKbps: draft.bandwidth.trim() === "" ? null : Number(draft.bandwidth.trim()),
    ...(draft.windows.length > 0 ? { bandwidthWindows: windowsOfDrafts(draft.windows) } : {}),
    ...(draft.readConcurrency.trim() !== ""
      ? { readConcurrency: Number(draft.readConcurrency.trim()) }
      : {}),
    skipOffline: draft.skipOffline,
    retention: {
      keepDaily: Number(draft.keepDaily.trim()),
      keepWeekly: Number(draft.keepWeekly.trim()),
      keepMonthly: Number(draft.keepMonthly.trim()),
    },
  };
}

function membersOf(draft: ShareJobDraft) {
  return draft.members.map((member) => ({
    id: member.id,
    ...(member.includes.length > 0 ? { overrides: { includes: member.includes } } : {}),
  }));
}

export function shareCreateInputOf(draft: ShareJobDraft): CreateBackupJobInput {
  return {
    kind: "share",
    name: draft.name.trim(),
    schedule: draft.scheduleOn ? shareScheduleOf(draft.schedule) : null,
    scope: { mode: "selected", members: membersOf(draft) },
    settings: shareSettingsOf(draft),
    enabled: draft.enabled,
    ...(draft.members.some((member) => member.job !== null) ? { moveMembers: true } : {}),
  };
}

function settingsKey(settings: JobEndpointSettings): string {
  const { bandwidthWindows, ...rest } = settings;
  const sorted = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ ...sorted, windows: windowsKey(bandwidthWindows) });
}

/** Only what changed; null when nothing did. The members are replaced separately. */
export function shareUpdateInputOf(
  job: BackupJob,
  draft: ShareJobDraft,
): UpdateBackupJobInput | null {
  const patch: UpdateBackupJobInput = {};
  if (draft.name.trim() !== job.name) patch.name = draft.name.trim();
  const schedule = draft.scheduleOn ? shareScheduleOf(draft.schedule) : null;
  if (scheduleKey(schedule) !== scheduleKey(job.schedule)) patch.schedule = schedule;
  if (draft.enabled !== job.enabled) patch.enabled = draft.enabled;
  const settings = shareSettingsOf(draft);
  if (settingsKey(settings) !== settingsKey(job.settings ?? {})) patch.settings = settings;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Whether the members (or their folders) differ from what the server holds. */
export function shareMembersChanged(members: readonly JobMember[], draft: ShareJobDraft): boolean {
  const key = (items: { id: string; includes: string[] }[]) =>
    JSON.stringify(
      [...items]
        .map((item) => ({ id: item.id, includes: [...item.includes].sort() }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  return (
    key(
      members.map((member) => ({ id: member.targetId, includes: member.overrides.includes ?? [] })),
    ) !== key(draft.members)
  );
}

export function shareMemberInputs(draft: ShareJobDraft) {
  return membersOf(draft);
}

// --- Copy jobs -------------------------------------------------------------------------------

export interface CopyJobDraft {
  name: string;
  enabled: boolean;
  scheduleOn: boolean;
  schedule: ShareScheduleDraft;
  sourceId: string;
  targetId: string;
  targetFolder: string;
  mode: "overwrite" | "mirror";
  restorePermissions: boolean;
  /** null: as for restores (on for NFS targets). */
  verify: boolean | null;
}

export function newCopyJobDraft(
  defaults: JobDefaults | undefined,
  prefill: { source?: string | null; target?: string | null; folder?: string | null } = {},
): CopyJobDraft {
  const zone = defaults?.timeZone ?? "Europe/Berlin";
  return {
    name: "",
    enabled: true,
    scheduleOn: true,
    schedule: shareScheduleDraftOf(defaults?.schedule, zone, "06:00"),
    sourceId: prefill.source ?? "",
    targetId: prefill.target ?? "",
    targetFolder: prefill.folder ?? "",
    mode: "overwrite",
    restorePermissions: false,
    verify: null,
  };
}

export function draftOfCopyJob(job: BackupJob): CopyJobDraft {
  const zone = job.schedule?.timeZone ?? "Europe/Berlin";
  return {
    name: job.name,
    enabled: job.enabled,
    scheduleOn: job.schedule !== null,
    schedule: shareScheduleDraftOf(job.schedule, zone, "06:00"),
    sourceId: job.copy?.source.id ?? "",
    targetId: job.copy?.target.id ?? "",
    targetFolder: job.copy?.targetFolder ?? job.settings.targetFolder ?? "",
    mode: job.copy?.mode ?? job.settings.mode ?? "overwrite",
    restorePermissions: job.settings.restorePermissions === true,
    verify: typeof job.settings.verify === "boolean" ? job.settings.verify : null,
  };
}

export function cleanFolder(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");
}

export interface CopyJobProblems {
  name?: FormProblem;
  schedule?: ShareScheduleProblems;
  source?: FormProblem;
  target?: FormProblem;
  targetFolder?: FormProblem;
}

/** Rules 2 and 3 of 4.10 as far as the form can tell; the API checks every rule again. */
export function checkCopyJobDraft(draft: CopyJobDraft): CopyJobProblems {
  const problems: CopyJobProblems = {};
  const name = draft.name.trim();
  if (name === "") problems.name = { code: "nameRequired" };
  else if (name.length > LIMITS.name)
    problems.name = { code: "nameTooLong", values: { max: LIMITS.name } };
  if (draft.scheduleOn) {
    const schedule = checkShareSchedule(draft.schedule);
    if (Object.keys(schedule).length > 0) problems.schedule = schedule;
  }
  if (!draft.sourceId) problems.source = { code: "required" };
  if (!draft.targetId) problems.target = { code: "required" };
  else if (draft.targetId === draft.sourceId) problems.target = { code: "copy.sameShare" };
  const folder = cleanFolder(draft.targetFolder);
  if (folder.split("/").some((segment) => segment === "." || segment === "..")) {
    problems.targetFolder = { code: "copy.folderInvalid" };
  } else if (draft.mode === "mirror" && folder === "") {
    problems.targetFolder = { code: "copy.mirrorRoot" };
  }
  return problems;
}

function copySettingsOf(draft: CopyJobDraft): JobEndpointSettings {
  return {
    targetFolder: cleanFolder(draft.targetFolder),
    mode: draft.mode,
    restorePermissions: draft.restorePermissions,
    ...(draft.verify !== null ? { verify: draft.verify } : {}),
  };
}

export function copyCreateInputOf(
  draft: CopyJobDraft,
  confirmMirror = false,
): CreateBackupJobInput {
  return {
    kind: "copy",
    name: draft.name.trim(),
    schedule: draft.scheduleOn ? shareScheduleOf(draft.schedule) : null,
    sourceFileShareId: draft.sourceId,
    targetFileShareId: draft.targetId,
    settings: copySettingsOf(draft),
    enabled: draft.enabled,
    ...(confirmMirror ? { confirmMirror: true } : {}),
  };
}

export function copyUpdateInputOf(
  job: BackupJob,
  draft: CopyJobDraft,
  confirmMirror = false,
): UpdateBackupJobInput | null {
  const patch: UpdateBackupJobInput = {};
  if (draft.name.trim() !== job.name) patch.name = draft.name.trim();
  const schedule = draft.scheduleOn ? shareScheduleOf(draft.schedule) : null;
  if (scheduleKey(schedule) !== scheduleKey(job.schedule)) patch.schedule = schedule;
  if (draft.enabled !== job.enabled) patch.enabled = draft.enabled;
  if (draft.sourceId !== (job.copy?.source.id ?? "")) patch.sourceFileShareId = draft.sourceId;
  if (draft.targetId !== (job.copy?.target.id ?? "")) patch.targetFileShareId = draft.targetId;
  const settings = copySettingsOf(draft);
  const current = {
    targetFolder: job.settings.targetFolder ?? "",
    mode: job.settings.mode ?? "overwrite",
    restorePermissions: job.settings.restorePermissions === true,
    ...(typeof job.settings.verify === "boolean" ? { verify: job.settings.verify } : {}),
  };
  if (JSON.stringify(settings) !== JSON.stringify(current)) patch.settings = settings;
  if (Object.keys(patch).length === 0) return null;
  return confirmMirror ? { ...patch, confirmMirror: true } : patch;
}

/** The folder a mirror confirmation names: the person types it to confirm (12.6). */
export function mirrorConfirmationMatches(typed: string, folder: string): boolean {
  return cleanFolder(typed) === cleanFolder(folder) && cleanFolder(folder) !== "";
}
