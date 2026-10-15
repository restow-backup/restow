import {
  REPORT_EVENTS,
  type ReportEvent,
  type ReportRule,
  type ReportRuleInput,
  type ReportSection,
  type ReportTrigger,
} from "./api";

/**
 * Pure logic of the reports page: the editor's form state and how it maps to
 * a request, the cadence presets a report offers (daily, weekly, monthly, or a
 * cron expression), and small labels. Tested without a browser.
 */

export const REPORTS_ROLES = ["provider_admin", "tenant_admin"] as const;

export type Frequency = "daily" | "weekly" | "monthly" | "custom";

export interface RuleFormState {
  trigger: ReportTrigger;
  name: string;
  enabled: boolean;
  events: ReportEvent[];
  throttleMinutes: number;
  frequency: Frequency;
  /** 0 = Sunday … 6 = Saturday, as in cron. */
  weekday: number;
  /** "HH:MM" */
  time: string;
  cron: string;
  timezone: string;
  periodDays: number;
  sections: ReportSection[];
  recipientsText: string;
  inApp: boolean;
  webhookId: string | null;
  language: "de" | "en" | null;
  /** `backup.overdue` by the rule's own deadline instead of the jobs' schedules. */
  overdueCustom: boolean;
  /** That deadline in hours, as typed. */
  overdueHours: string;
}

export type RuleFormErrors = Partial<
  Record<
    | "name"
    | "events"
    | "sections"
    | "channels"
    | "time"
    | "cron"
    | "timezone"
    | "recipients"
    | "overdueHours",
    string
  >
>;

/** The deadline a rule may set for `backup.overdue`: a day to 30 days (as the server checks). */
export const OVERDUE_DEADLINE_HOURS = { min: 24, max: 720, initial: 72 } as const;

/** The deadline typed into the form, or null when it is no whole number of hours in range. */
export function parseOverdueHours(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const hours = Number(trimmed);
  return hours >= OVERDUE_DEADLINE_HOURS.min && hours <= OVERDUE_DEADLINE_HOURS.max ? hours : null;
}

/** Whether the form sets its own deadline for `backup.overdue` (the event chosen, the option on). */
export function usesOverdueDeadline(
  form: Pick<RuleFormState, "trigger" | "events" | "overdueCustom">,
) {
  return form.trigger === "event" && form.overdueCustom && form.events.includes("backup.overdue");
}

export const THROTTLE_OPTIONS = [0, 15, 60, 240, 1440] as const;

export const EVENT_GROUPS: Record<
  "jobs" | "recoverability" | "storage" | "system",
  readonly ReportEvent[]
> = {
  jobs: [
    "backup.failed",
    "backup.overdue",
    "restore.failed",
    "restore.completed",
    "archive.failed",
    "directory.failed",
    "endpoint.stale",
    "endpoint.repository_locked",
    "file_share.repository_locked",
  ],
  recoverability: ["verify.red", "verify.yellow", "verify.recovered"],
  storage: [
    "scrub.corrupt",
    "scrub.repaired",
    "endpoint.suspicious_snapshot",
    "endpoint.storage_quota",
    "file_share.storage_quota",
  ],
  // About the installation, not a tenant's data: only provider administrators may pick these.
  system: ["update.available"],
};

/** The event groups a person may put into a rule (installation events are the provider's). */
export function eventGroupsFor(providerAdmin: boolean): (keyof typeof EVENT_GROUPS)[] {
  return (Object.keys(EVENT_GROUPS) as (keyof typeof EVENT_GROUPS)[]).filter(
    (group) => group !== "system" || providerAdmin,
  );
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function emptyRuleForm(trigger: ReportTrigger, timezone = browserTimeZone()): RuleFormState {
  return {
    trigger,
    name: "",
    enabled: true,
    events:
      trigger === "event" ? ["backup.failed", "restore.failed", "verify.red", "scrub.corrupt"] : [],
    throttleMinutes: 60,
    frequency: "weekly",
    weekday: 1,
    time: "07:00",
    cron: "",
    timezone,
    periodDays: 7,
    sections:
      trigger === "schedule" ? ["backups", "readiness", "failures", "storage", "restores"] : [],
    recipientsText: "",
    inApp: trigger === "schedule",
    webhookId: null,
    language: null,
    overdueCustom: false,
    overdueHours: String(OVERDUE_DEADLINE_HOURS.initial),
  };
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The cron expression of a preset, or null when the time is not valid. */
export function presetCron(frequency: Exclude<Frequency, "custom">, weekday: number, time: string) {
  const match = TIME.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  switch (frequency) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
    case "monthly":
      return `${minute} ${hour} 1 * *`;
  }
}

/** Recognise a stored cron as one of the presets, so editing shows the simple form. */
export function presetOf(
  cron: string | null,
): { frequency: Frequency; weekday: number; time: string } | null {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || month !== "*") return null;
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (!TIME.test(time)) return null;
  if (dayOfMonth === "*" && dayOfWeek === "*") return { frequency: "daily", weekday: 1, time };
  if (dayOfMonth === "*" && /^[0-6]$/.test(dayOfWeek)) {
    return { frequency: "weekly", weekday: Number(dayOfWeek), time };
  }
  if (dayOfMonth === "1" && dayOfWeek === "*") return { frequency: "monthly", weekday: 1, time };
  return null;
}

export function ruleToForm(rule: ReportRule): RuleFormState {
  const preset = presetOf(rule.cron);
  return {
    trigger: rule.trigger,
    name: rule.name,
    enabled: rule.enabled,
    events: [...rule.events],
    throttleMinutes: rule.throttleMinutes,
    frequency: preset?.frequency ?? "custom",
    weekday: preset?.weekday ?? 1,
    time: preset?.time ?? "07:00",
    cron: rule.cron ?? "",
    timezone: rule.timezone,
    periodDays: rule.periodDays,
    sections: [...rule.sections],
    recipientsText: rule.emailRecipients.join("\n"),
    inApp: rule.inApp,
    webhookId: rule.webhookId,
    language: rule.language,
    overdueCustom: typeof rule.overdueAfterHours === "number",
    overdueHours: String(rule.overdueAfterHours ?? OVERDUE_DEADLINE_HOURS.initial),
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Addresses from the text field: one per line, or separated by commas or semicolons. */
export function parseRecipients(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,;]+/)) {
    const address = raw.trim().toLowerCase();
    if (address.length === 0 || seen.has(address)) continue;
    seen.add(address);
    (EMAIL.test(address) ? valid : invalid).push(address);
  }
  return { valid, invalid };
}

/** The IANA zones this browser knows, for the time zone suggestions (empty where it cannot say). */
export function knownTimeZones(): string[] {
  try {
    const zones = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
      "timeZone",
    );
    return zones ? [...zones, ...(zones.includes("UTC") ? [] : ["UTC"])] : [];
  } catch {
    return [];
  }
}

/** Whether `zone` is a time zone this browser can use (the server checks it the same way). */
export function isKnownTimeZone(zone: string): boolean {
  if (zone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone.trim() });
    return true;
  } catch {
    return false;
  }
}

/** Problems of the form as translation keys (namespace `reports`); empty when it can be saved. */
export function validateRuleForm(form: RuleFormState): RuleFormErrors {
  const errors: RuleFormErrors = {};
  if (form.name.trim().length === 0) errors.name = "editor.errors.name";
  const recipients = parseRecipients(form.recipientsText);
  if (recipients.invalid.length > 0) errors.recipients = "editor.errors.recipients";
  if (form.trigger === "event" && form.events.length === 0) errors.events = "editor.errors.events";
  if (usesOverdueDeadline(form) && parseOverdueHours(form.overdueHours) === null) {
    errors.overdueHours = "editor.errors.overdueHours";
  }
  if (form.trigger === "schedule") {
    if (form.sections.length === 0) errors.sections = "editor.errors.sections";
    if (form.frequency === "custom") {
      if (form.cron.trim().split(/\s+/).length !== 5) errors.cron = "editor.errors.cron";
    } else if (!TIME.test(form.time)) {
      errors.time = "editor.errors.time";
    }
    // Said here, in the reader's language, instead of after saving by the server.
    if (!isKnownTimeZone(form.timezone)) errors.timezone = "editor.errors.timezone";
  }
  const hasChannel =
    recipients.valid.length > 0 ||
    form.webhookId !== null ||
    (form.trigger === "schedule" && form.inApp);
  if (!hasChannel) errors.channels = "editor.errors.channels";
  return errors;
}

/** The request for a valid form. */
export function formToInput(form: RuleFormState): ReportRuleInput {
  const schedule = form.trigger === "schedule";
  const cron = !schedule
    ? null
    : form.frequency === "custom"
      ? form.cron.trim()
      : presetCron(form.frequency, form.weekday, form.time);
  return {
    trigger: form.trigger,
    name: form.name.trim(),
    enabled: form.enabled,
    events: schedule ? [] : REPORT_EVENTS.filter((event) => form.events.includes(event)),
    throttleMinutes: form.throttleMinutes,
    intervalMinutes: null,
    cron,
    timezone: form.timezone,
    periodDays: form.periodDays,
    sections: schedule ? [...form.sections] : [],
    emailRecipients: parseRecipients(form.recipientsText).valid,
    inApp: schedule ? form.inApp : false,
    webhookId: form.webhookId,
    language: form.language,
    overdueAfterHours: usesOverdueDeadline(form) ? parseOverdueHours(form.overdueHours) : null,
  };
}

/** Channels of a rule for the list: "2 recipients · bell · webhook". */
export function channelSummary(
  rule: Pick<ReportRule, "emailRecipients" | "inApp" | "webhookId" | "trigger">,
): { recipients: number; inApp: boolean; webhook: boolean } {
  return {
    recipients: rule.emailRecipients.length,
    inApp: rule.trigger === "schedule" && rule.inApp,
    webhook: rule.webhookId !== null,
  };
}
