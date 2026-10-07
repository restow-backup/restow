import type { ReportEvent } from "./catalog.js";

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
 * The deliveries one firing of `rule` needs. Event alerts always reach the
 * bell through the in-app notification the worker writes anyway, so the
 * `inApp` flag adds a bell entry for summary reports only. Addresses are
 * deduplicated case-insensitively.
 */
export function plannedDeliveries(
  rule: Pick<RuleForDelivery, "emailRecipients" | "inApp" | "webhookId">,
  kind: "event" | "summary",
): PlannedDelivery[] {
  const seen = new Set<string>();
  const deliveries: PlannedDelivery[] = [];
  for (const address of rule.emailRecipients) {
    const trimmed = address.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deliveries.push({ channel: "email", recipient: trimmed });
  }
  if (kind === "summary" && rule.inApp) {
    deliveries.push({ channel: "in_app", recipient: null });
  }
  if (rule.webhookId) {
    deliveries.push({ channel: "webhook", recipient: rule.webhookId });
  }
  return deliveries;
}

/**
 * What an alert is about, for throttling: the protected object when the event
 * has one, else the job queue, else the event itself.
 */
export function subjectKeyOf(event: ReportEvent, details: Record<string, unknown>): string {
  // An update alert is about one version: a new version is a new subject.
  if (event === "update.available" && typeof details.version === "string") {
    return `update:${details.version}`;
  }
  // An alert about a VM or container of Proxmox VE is about that guest.
  const guest = details.pveGuestId;
  if (typeof guest === "string" && guest.length > 0) {
    return `guest:${guest}`;
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
