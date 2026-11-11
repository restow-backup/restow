import { nextCronOccurrence, parseCron } from "../schedule/cron.js";
import {
  DELIVERY_FAILED_EVENT,
  isFloorReportEvent,
  isReportEvent,
  REPORT_EVENT_INFO,
  type ReportEvent,
  type ReportEventLevel,
} from "./catalog.js";

/**
 * Pure rule logic shared by the worker (event rules), the scheduler (report
 * rules) and the API (test sends): which rules an event reaches, whether an
 * alert is throttled, and which deliveries one firing turns into.
 */

export type ReportChannelName = "email" | "in_app" | "webhook";

/** The rule fields the fan-out reads (a subset of the `report_rules` row). */
export interface RuleForDelivery {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: "event" | "schedule";
  readonly events: readonly string[];
  readonly throttleMinutes: number;
  readonly emailRecipients: readonly string[];
  readonly inApp: boolean;
  readonly webhookId: string | null;
  readonly language: "de" | "en" | null;
  /** The rule's own `backup.overdue` deadline in hours; null or absent follows the schedules. */
  readonly overdueAfterHours?: number | null;
}

/** One planned outbox row: a channel and, for e-mail, the recipient. */
export interface PlannedDelivery {
  readonly channel: ReportChannelName;
  /** The address for e-mail, the webhook id for a webhook, null for the bell. */
  readonly recipient: string | null;
  /** E-mail only: held for the recipient's hourly or daily digest instead of sent at once. */
  readonly digest?: DigestWindow;
}

/** How a recipient wants the alerts of one severity: at once, or collected in a digest. */
export type DeliveryMode = "immediate" | "hourly" | "daily";

/** The digest windows (an e-mail recipient's {@link DeliveryMode} other than `immediate`). */
export type DigestWindow = Exclude<DeliveryMode, "immediate">;

export const DELIVERY_MODES: readonly DeliveryMode[] = ["immediate", "hourly", "daily"];

/** A recipient's mode per severity; a severity that is absent is sent at once. */
export type DeliveryModes = Partial<Record<ReportEventLevel, DeliveryMode>>;

/** Every severity with its mode, the absent ones `immediate` (what the API answers). */
export function completeDeliveryModes(
  modes: DeliveryModes | null | undefined,
): Record<ReportEventLevel, DeliveryMode> {
  const pick = (value: unknown): DeliveryMode =>
    value === "hourly" || value === "daily" ? value : "immediate";
  return { error: pick(modes?.error), warning: pick(modes?.warning), info: pick(modes?.info) };
}

/** Only the severities that are not sent at once, as stored (`delivery` jsonb). */
export function storedDeliveryModes(modes: DeliveryModes | null | undefined): DeliveryModes {
  const complete = completeDeliveryModes(modes);
  const stored: DeliveryModes = {};
  for (const level of ["error", "warning", "info"] as const) {
    if (complete[level] !== "immediate") stored[level] = complete[level];
  }
  return stored;
}

/**
 * How one alert reaches a recipient: the mode of its severity, but the critical events and the
 * failed delivery are always sent at once (catalog `critical`, {@link DELIVERY_FAILED_EVENT}).
 * `level` is the alert's own severity when it has one (a `directory.failed` is a warning, an
 * expired secret an error), else the catalog's.
 */
export function deliveryModeFor(
  modes: DeliveryModes | null | undefined,
  event: string,
  level?: ReportEventLevel | null,
): DeliveryMode {
  if (isFloorReportEvent(event)) {
    return "immediate";
  }
  const severity = level ?? (isReportEvent(event) ? REPORT_EVENT_INFO[event].level : "info");
  return completeDeliveryModes(modes)[severity];
}

const DAILY_DIGEST = parseCron("0 7 * * *");

/**
 * When a digest of `window` that collects an alert raised at `now` is sent: hourly at the next
 * full hour (UTC), daily at the next 07:00 in `timeZone` (the tenant's, else the installation's).
 */
export function digestDueAt(window: DigestWindow, now: Date, timeZone: string): Date {
  if (window === "hourly") {
    const hour = 60 * 60_000;
    return new Date((Math.floor(now.getTime() / hour) + 1) * hour);
  }
  const zone = (() => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return timeZone;
    } catch {
      return "UTC";
    }
  })();
  return nextCronOccurrence(DAILY_DIGEST, now, zone) ?? new Date(now.getTime() + 24 * 60 * 60_000);
}

/** Channels a firing leaves out (a failed delivery's alert never goes through what failed). */
export interface DeliveryExclusion {
  /** A webhook that keeps failing. */
  readonly webhookId?: string;
  /** An address that cannot be mailed (compared case-insensitively). */
  readonly email?: string;
  /** The mail transport is down: no e-mail at all. */
  readonly allEmail?: boolean;
}

/**
 * The exclusion a `notification.delivery_failed` alert carries in its details: the webhook it is
 * about, the address that failed, or every e-mail while the transport is down. Empty for every
 * other event.
 */
export function deliveryFailureExclusion(
  event: string,
  details: Record<string, unknown> | null | undefined,
): DeliveryExclusion {
  if (event !== DELIVERY_FAILED_EVENT || !details) {
    return {};
  }
  if (details.channel === "webhook" && typeof details.webhookId === "string") {
    return { webhookId: details.webhookId };
  }
  if (details.channel === "email") {
    if (details.scope === "transport") {
      return { allEmail: true };
    }
    if (typeof details.recipient === "string" && details.recipient.trim().length > 0) {
      return { email: details.recipient.trim().toLowerCase() };
    }
  }
  return {};
}

/**
 * The rule's own "no successful backup for X hours" deadline: set only on an event rule that
 * listens for `backup.overdue`; null when the rule follows the bound of the jobs' schedules.
 * Such a rule gets its `backup.overdue` alerts from the overdue pass by its own deadline, never
 * with the alert raised at the schedules' bound (apps/worker overdue.ts).
 */
export function overdueDeadlineOf(
  rule: Pick<RuleForDelivery, "trigger" | "events" | "overdueAfterHours">,
): number | null {
  if (rule.trigger !== "event" || !rule.events.includes("backup.overdue")) {
    return null;
  }
  return typeof rule.overdueAfterHours === "number" ? rule.overdueAfterHours : null;
}

/** The enabled event rules that listen for `event`. */
export function rulesForEvent<R extends RuleForDelivery>(
  rules: readonly R[],
  event: ReportEvent,
): R[] {
  return rules.filter(
    (rule) => rule.enabled && rule.trigger === "event" && rule.events.includes(event),
  );
}

/**
 * Whether an alert is held back: the same rule already alerted about the
 * same subject (one mailbox, one job queue) within its throttle window. A
 * window of 0 never throttles.
 */
export function isAlertThrottled(
  lastAlertAt: Date | null,
  now: Date,
  throttleMinutes: number,
): boolean {
  if (lastAlertAt === null || throttleMinutes <= 0) {
    return false;
  }
  return now.getTime() - lastAlertAt.getTime() < throttleMinutes * 60_000;
}

/**
 * The columns of the tenant's channels in the notification matrix: the events each webhook and
 * each notification recipient gets. A channel missing here has no column (an address typed into
 * one rule only, a webhook deleted meanwhile) and is left to the rule.
 */
export interface ChannelColumns {
  /** Webhook id → its stored event list (`webhooks.events`). */
  readonly webhooks: ReadonlyMap<string, readonly string[]>;
  /** Lowercased address of a notification recipient → its events and its delivery modes. */
  readonly recipients: ReadonlyMap<string, RecipientColumn>;
}

/** A notification recipient's column: the events it gets and how (at once or in a digest). */
export interface RecipientColumn {
  readonly events: readonly string[];
  readonly delivery: DeliveryModes;
}

export const NO_CHANNEL_COLUMNS: ChannelColumns = { webhooks: new Map(), recipients: new Map() };

/**
 * The deliveries one firing of `rule` needs. Event alerts always reach the
 * bell through the in-app notification the worker writes anyway, so the
 * `inApp` flag adds a bell entry for summary reports only. Addresses are
 * deduplicated case-insensitively.
 *
 * With `channels`, an alert about `channels.event` leaves out every channel whose column has
 * the event off: a rule can no longer send an event to a webhook or a recipient that does not
 * want it. Summary reports are not events and are not filtered.
 */
export function plannedDeliveries(
  rule: Pick<RuleForDelivery, "emailRecipients" | "inApp" | "webhookId">,
  kind: "event" | "summary",
  channels?: {
    readonly event: string;
    readonly columns: ChannelColumns;
    /** The alert's own severity, for the recipients' digest modes (deliveryModeFor). */
    readonly level?: ReportEventLevel | null;
  },
  options: { readonly exclude?: DeliveryExclusion } = {},
): PlannedDelivery[] {
  const wants = (column: readonly string[] | undefined) =>
    kind !== "event" || !channels || column === undefined || column.includes(channels.event);
  const exclude = options.exclude ?? {};
  const seen = new Set<string>();
  const deliveries: PlannedDelivery[] = [];
  for (const address of rule.emailRecipients) {
    const trimmed = address.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (exclude.allEmail || exclude.email === key) {
      continue;
    }
    const column = channels?.columns.recipients.get(key);
    if (!wants(column?.events)) {
      continue;
    }
    const mode =
      kind === "event" && channels && column
        ? deliveryModeFor(column.delivery, channels.event, channels.level)
        : "immediate";
    deliveries.push(
      mode === "immediate"
        ? { channel: "email", recipient: trimmed }
        : { channel: "email", recipient: trimmed, digest: mode },
    );
  }
  if (kind === "summary" && rule.inApp) {
    deliveries.push({ channel: "in_app", recipient: null });
  }
  if (
    rule.webhookId &&
    exclude.webhookId !== rule.webhookId &&
    wants(channels?.columns.webhooks.get(rule.webhookId))
  ) {
    deliveries.push({ channel: "webhook", recipient: rule.webhookId });
  }
  return deliveries;
}

/**
 * What an alert is about, for throttling: the protected object when the event
 * has one, else the job queue, else the event itself.
 */
export function subjectKeyOf(event: ReportEvent, details: Record<string, unknown>): string {
  // A failed delivery is about the channel that failed: the mail transport, one address, one
  // webhook. A new episode of the same channel is the same subject.
  if (event === DELIVERY_FAILED_EVENT) {
    if (details.channel === "webhook" && typeof details.webhookId === "string") {
      return `delivery:webhook:${details.webhookId}`;
    }
    if (details.scope === "transport") {
      return "delivery:email:transport";
    }
    if (typeof details.recipient === "string") {
      return `delivery:email:${details.recipient.trim().toLowerCase()}`;
    }
    return "delivery:unknown";
  }
  // An update alert is about one version: a new version is a new subject.
  if (event === "update.available" && typeof details.version === "string") {
    return `update:${details.version}`;
  }
  // A disk warning is about that disk (the database's or the repository's).
  if (event === "installation.disk_low" && typeof details.disk === "string") {
    return `disk:${details.disk}`;
  }
  // A release of the emergency disk reserve is about that one release, its recreation about
  // that one recreation: neither may fall into the throttle of the other.
  if (event === "installation.disk_reserve_released") {
    return `disk_reserve:released:${String(details.releasedAt ?? "")}`;
  }
  if (event === "installation.disk_reserve_restored") {
    return `disk_reserve:restored:${String(details.restoredAt ?? "")}`;
  }
  // An expiry reminder is about one credential's date and stage: the 7-day reminder must not
  // fall into the throttle of the 30-day one, and a new date is a new subject.
  if (event === "source.app_secret_expiring" && typeof details.sourceId === "string") {
    return `source_app:${details.sourceId}:${String(details.expiresAt ?? "")}:${String(details.stage ?? "")}`;
  }
  if (event === "installation.app_secret_expiring" && typeof details.expiresAt === "string") {
    return `entra_app:${details.expiresAt}:${String(details.stage ?? "")}`;
  }
  // The notice that an object is no longer backed up has its own subject: a `backup.failed` of
  // the same object shortly before (the run that met the lock) must not swallow it.
  if (event === "object.inactive" && typeof details.protectedObjectId === "string") {
    return `inactive:${details.protectedObjectId}`;
  }
  // Many objects inactive at once: one subject per tenant and UTC day. The warning about many
  // refused IMAP logins (`question: "login"`) is its own subject, so one never swallows the other.
  if (event === "object.inactive_many") {
    const question = details.question === "login" ? ":login" : "";
    return `inactive_many:${String(details.tenantId ?? "")}:${String(details.date ?? "")}${question}`;
  }
  // A restore mode is about that one activation: a new activation within the throttle window
  // (the previous one ended, a dump was restored again) is a new subject.
  if (event === "installation.restore_mode" && typeof details.restoreModeId === "string") {
    return `restore_mode:${details.restoreModeId}`;
  }
  // A wrapped key in storage that differs from the database's is about that key on that target
  // of that tenant: a finding on the copy, for another key version or another sealed password
  // document must not fall into the throttle of the first.
  if (event === "installation.key_mirror_conflict") {
    const key =
      typeof details.objectKey === "string" && details.objectKey.length > 0
        ? details.objectKey
        : String(details.keyVersion ?? "");
    return `key_mirror:${String(details.tenantId ?? "")}:${String(details.targetId ?? "")}:${key}`;
  }
  // A held backup run is about that one hold: an alert about the object's failed run shortly
  // before must not swallow it.
  if (event === "backup.unusually_large" && typeof details.holdId === "string") {
    return `size_hold:${details.holdId}`;
  }
  // An alert about a VM or container of Proxmox VE is about that guest.
  const guest = details.pveGuestId;
  if (typeof guest === "string" && guest.length > 0) {
    return `guest:${guest}`;
  }
  // An alert about a file share is about that share.
  const share = details.fileShareId;
  if (typeof share === "string" && share.length > 0) {
    return `file_share:${share}`;
  }
  // An alert about an endpoint (server or client) is about that machine.
  const endpoint = details.endpointId;
  if (typeof endpoint === "string" && endpoint.length > 0) {
    return `endpoint:${endpoint}`;
  }
  const object = details.protectedObjectId;
  if (typeof object === "string" && object.length > 0) {
    return `object:${object}`;
  }
  const queue = details.queue;
  if (typeof queue === "string" && queue.length > 0) {
    return `queue:${queue}`;
  }
  return `event:${event}`;
}

/** Retry schedule of a failed delivery: 1, 5, 15, 60 minutes, then give up. */
export const REPORT_RETRY_DELAYS_MINUTES = [1, 5, 15, 60] as const;
export const MAX_REPORT_ATTEMPTS = REPORT_RETRY_DELAYS_MINUTES.length + 1;

/** When to try again after attempt `attempts` failed, or null when to give up. */
export function nextAttemptAfter(attempts: number, now: Date): Date | null {
  const delay = REPORT_RETRY_DELAYS_MINUTES[attempts - 1];
  if (delay === undefined) {
    return null;
  }
  return new Date(now.getTime() + delay * 60_000);
}
