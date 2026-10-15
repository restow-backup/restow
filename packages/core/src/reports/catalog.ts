/**
 * What reports and notifications can react to and contain
 * (docs/ARCHITECTURE.md, Reports and notifications). The event names are the
 * ones the worker writes to the in-app notifications as well, so the bell,
 * the rules and the delivery log speak the same language. The UI and the
 * mail texts translate them (packages/i18n, namespace `reports`).
 */

/** Events the product raises. Each one belongs to a group the rule editor shows together. */
export const REPORT_EVENTS = [
  "backup.failed",
  "backup.overdue",
  "backup.succeeded",
  "restore.failed",
  "restore.completed",
  "archive.failed",
  "directory.failed",
  "verify.red",
  "verify.yellow",
  "verify.recovered",
  "verify.completed",
  "boot_test.failed",
  "boot_test.unproven",
  "scrub.corrupt",
  "scrub.repaired",
  "endpoint.stale",
  "endpoint.suspicious_snapshot",
  "endpoint.storage_quota",
  "endpoint.repository_locked",
  "file_share.storage_quota",
  "file_share.repository_locked",
  "update.available",
  "installation.disk_low",
] as const;

export type ReportEvent = (typeof REPORT_EVENTS)[number];

export type ReportEventLevel = "info" | "warning" | "error";

/**
 * The events of the signed webhook stream (`X-Restow-Event`), sent with their own payload to
 * every webhook that has them in its event list (apps/api lib/webhooks.ts, apps/worker
 * handlers/webhooks.ts). Their names are a public contract and never change; each one carries
 * one or more events of the catalog, see `webhookEvent` below and {@link webhookEventRow}.
 */
export type WebhookEvent = "job.failed" | "job.completed" | "verify.completed";

export interface ReportEventInfo {
  readonly group: "jobs" | "recoverability" | "storage" | "system";
  readonly level: ReportEventLevel;
  /**
   * The webhook stream event that also carries this event, when there is one: a webhook that
   * subscribed to it gets that payload for this event as long as its column has the event on.
   */
  readonly webhookEvent?: WebhookEvent;
}

export const REPORT_EVENT_INFO: Readonly<Record<ReportEvent, ReportEventInfo>> = {
  // Any failed run of the webhook stream that is no restore, archive or directory sync counts
  // as a failed backup there (webhookEventRow).
  "backup.failed": { group: "jobs", level: "error", webhookEvent: "job.failed" },
  // No successful backup of a mailbox, OneDrive, IMAP account, server or client for longer than
  // its jobs' schedules allow (twice the longest planned gap; apps/worker overdue.ts).
  "backup.overdue": { group: "jobs", level: "warning" },
  // A backup run finished. On the webhook stream it is `job.completed`, the name that event had
  // before the catalog knew it (an alias, never renamed on the wire): every finished run that is
  // no restore counts as one there.
  "backup.succeeded": { group: "jobs", level: "info", webhookEvent: "job.completed" },
  "restore.failed": { group: "jobs", level: "error", webhookEvent: "job.failed" },
  "restore.completed": { group: "jobs", level: "info", webhookEvent: "job.completed" },
  "archive.failed": { group: "jobs", level: "error", webhookEvent: "job.failed" },
  "directory.failed": { group: "jobs", level: "warning", webhookEvent: "job.failed" },
  "verify.red": { group: "recoverability", level: "error" },
  "verify.yellow": { group: "recoverability", level: "warning" },
  "verify.recovered": { group: "recoverability", level: "info" },
  // A restore check finished, whatever its rating (the same name on the webhook stream).
  "verify.completed": {
    group: "recoverability",
    level: "info",
    webhookEvent: "verify.completed",
  },
  // A boot test of a Proxmox VE restore point failed: the restore, the start or the boot of the
  // temporary guest did not work (docs/PVE.md, "Boot test").
  "boot_test.failed": { group: "recoverability", level: "error" },
  // A boot test's temporary VM started and kept running, but its QEMU guest agent never
  // answered: no proof that the system inside works.
  "boot_test.unproven": { group: "recoverability", level: "warning" },
  "scrub.corrupt": { group: "storage", level: "error" },
  "scrub.repaired": { group: "storage", level: "info" },
  // An endpoint (server or client, docs/AGENT.md) went silent or missed its backups.
  "endpoint.stale": { group: "jobs", level: "warning" },
  // A snapshot no backup run reported, or one dated in the future, appeared in an endpoint's
  // repository: retention leaves it alone, and the machine may be compromised.
  "endpoint.suspicious_snapshot": { group: "storage", level: "error" },
  // An endpoint's repository (or all of a tenant's) reached 90 % of its storage budget, or
  // an upload was refused because the budget is used up.
  "endpoint.storage_quota": { group: "storage", level: "warning" },
  // Retention and checks of an endpoint's repository kept finding it locked.
  "endpoint.repository_locked": { group: "jobs", level: "warning" },
  // A file share's repository (or all of a tenant's shares) reached 80 % of its storage budget,
  // or the budget is used up and new backups are refused (docs/FILESHARES.md 7.4).
  "file_share.storage_quota": { group: "storage", level: "warning" },
  // Retention and checks of a file share's repository kept finding it locked.
  "file_share.repository_locked": { group: "jobs", level: "warning" },
  "update.available": { group: "system", level: "info" },
  // The disk under the database or under the installation's local default repository runs low
  // (apps/api features/updates/disk-watch.ts, docs/DATABASE.md "Disk space"): once per episode.
  "installation.disk_low": { group: "system", level: "warning" },
};

/**
 * Events about the installation, not about one tenant's data. They are raised
 * once for the whole installation and reach the rules of every tenant that
 * lists them, but only provider administrators may put them into a rule (a
 * tenant's own administrators are not told about the operator's updates).
 */
export const INSTALLATION_REPORT_EVENTS: readonly ReportEvent[] = [
  "update.available",
  "installation.disk_low",
];

export function isInstallationReportEvent(event: string): boolean {
  return (INSTALLATION_REPORT_EVENTS as readonly string[]).includes(event);
}

export function isReportEvent(value: string): value is ReportEvent {
  return (REPORT_EVENTS as readonly string[]).includes(value);
}

/**
 * Events every successful run raises. The bell writes them only when its column has them on
 * (a row per backup would bury everything else), and a channel that existed before they did
 * starts without them.
 */
export const ROUTINE_REPORT_EVENTS: readonly ReportEvent[] = [
  "backup.succeeded",
  "verify.completed",
];

// ---------------------------------------------------------------------------
// The webhook stream, derived from the catalog
// ---------------------------------------------------------------------------

/** The events a webhook can subscribe to, in catalog order: those some catalog event names. */
export const WEBHOOK_EVENTS: readonly [WebhookEvent, ...WebhookEvent[]] = [
  ...new Set(
    REPORT_EVENTS.flatMap((event) => {
      const wire = REPORT_EVENT_INFO[event].webhookEvent;
      return wire ? [wire] : [];
    }),
  ),
] as [WebhookEvent, ...WebhookEvent[]];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** The catalog events `wire` carries. */
export function reportEventsOfWebhookEvent(wire: WebhookEvent): ReportEvent[] {
  return REPORT_EVENTS.filter((event) => REPORT_EVENT_INFO[event].webhookEvent === wire);
}

/**
 * The catalog event one delivery of the webhook stream is about, read from its payload: the
 * row of the matrix that decides whether a webhook gets it. `job.failed` and `job.completed`
 * go by the run's queue (`data.job.queue`): a restore (of a mailbox, a file share or a
 * machine) is a restore, an archive or directory sync is one of those, everything else counts
 * as a backup.
 */
export function webhookEventRow(wire: WebhookEvent, data: Record<string, unknown>): ReportEvent {
  if (wire === "verify.completed") {
    return "verify.completed";
  }
  const job = data.job;
  const queue =
    job !== null &&
    typeof job === "object" &&
    typeof (job as { queue?: unknown }).queue === "string"
      ? (job as { queue: string }).queue
      : "";
  const restore = queue === "restore" || queue.endsWith("restore");
  if (wire === "job.completed") {
    return restore ? "restore.completed" : "backup.succeeded";
  }
  return FAILED_JOB_EVENTS[queue] ?? (restore ? "restore.failed" : "backup.failed");
}

// ---------------------------------------------------------------------------
// Channels: which events each one gets
// ---------------------------------------------------------------------------

/** The quick choices of a channel's column: errors only, errors and warnings, everything. */
export type ChannelPreset = "errors" | "warnings" | "all";

const PRESET_LEVELS: Readonly<Record<ChannelPreset, readonly ReportEventLevel[]>> = {
  errors: ["error"],
  warnings: ["error", "warning"],
  all: ["error", "warning", "info"],
};

/** The events of `preset`, among `events` (the catalog by default). */
export function presetEvents(
  preset: ChannelPreset,
  events: readonly ReportEvent[] = REPORT_EVENTS,
): ReportEvent[] {
  const levels = PRESET_LEVELS[preset];
  return events.filter((event) => levels.includes(REPORT_EVENT_INFO[event].level));
}

/**
 * What the bell shows while a tenant never chose (`tenants.bell_events` null): every event but
 * the routine ones, exactly what it showed before it had a column.
 */
export const DEFAULT_BELL_EVENTS: readonly ReportEvent[] = REPORT_EVENTS.filter(
  (event) => !ROUTINE_REPORT_EVENTS.includes(event),
);

/** The bell's column: what the tenant chose, or the default. Unknown names are dropped. */
export function bellEventsOf(stored: readonly string[] | null | undefined): ReportEvent[] {
  return stored
    ? REPORT_EVENTS.filter((event) => stored.includes(event))
    : [...DEFAULT_BELL_EVENTS];
}

/** The catalog events of a stored event list, in catalog order (webhook and recipient lists). */
export function catalogEventsOf(stored: readonly string[]): ReportEvent[] {
  return REPORT_EVENTS.filter((event) => stored.includes(event));
}

/** The webhook stream events of a webhook's stored list. */
export function webhookEventsOf(stored: readonly string[]): WebhookEvent[] {
  return WEBHOOK_EVENTS.filter((event) => stored.includes(event));
}

/** Formats whose requests are chat messages (mirrors the `webhook_format` enum). */
const CHAT_FORMATS: readonly string[] = ["discord", "slack", "teams"];

/**
 * The event list a new webhook starts with: a chat webhook (Discord, Slack, Teams) gets errors
 * and warnings, so a successful run does not post to the channel; a signed JSON webhook gets
 * everything, as before the matrix. The webhook stream events those events name are subscribed.
 */
export function defaultWebhookEvents(format: string): string[] {
  const events = presetEvents(CHAT_FORMATS.includes(format) ? "warnings" : "all");
  return withWebhookStream(events, []);
}

/** `events` plus the webhook stream events that carry any of `added`, plus `keep`. */
function withWebhookStream(
  events: readonly ReportEvent[],
  keep: readonly WebhookEvent[],
  added: readonly ReportEvent[] = events,
): string[] {
  const wires = new Set<WebhookEvent>(keep);
  for (const event of added) {
    const wire = REPORT_EVENT_INFO[event].webhookEvent;
    if (wire) wires.add(wire);
  }
  return [...catalogEventsOf(events), ...WEBHOOK_EVENTS.filter((wire) => wires.has(wire))];
}

/**
 * A webhook's stored list after its column in the matrix changed to `next`. An event switched on
 * also subscribes the webhook stream event that carries it (ticking "Backup succeeded" makes the
 * posts come); a stream event stays subscribed while one of its events is on, and goes with the
 * last. Events left as they were change nothing, so a webhook that only rules send to does not
 * start getting the stream.
 */
export function webhookColumnUpdate(
  stored: readonly string[],
  next: readonly ReportEvent[],
): string[] {
  const before = catalogEventsOf(stored);
  const nextEvents = catalogEventsOf(next);
  const kept = webhookEventsOf(stored).filter((wire) =>
    nextEvents.some((event) => REPORT_EVENT_INFO[event].webhookEvent === wire),
  );
  const added = nextEvents.filter((event) => !before.includes(event));
  return withWebhookStream(nextEvents, kept, added);
}

/**
 * A webhook's stored list after its stream subscription was set to `wires` (the webhook API,
 * which speaks stream events): a newly subscribed stream event switches its catalog events on;
 * an unsubscribed one only stops the stream, the events stay on for the rules that send there.
 */
export function webhookSubscriptionUpdate(
  stored: readonly string[],
  wires: readonly WebhookEvent[],
): string[] {
  const before = webhookEventsOf(stored);
  const events = new Set<ReportEvent>(catalogEventsOf(stored));
  for (const wire of wires) {
    if (!before.includes(wire)) {
      for (const event of reportEventsOfWebhookEvent(wire)) events.add(event);
    }
  }
  return [
    ...catalogEventsOf([...events]),
    ...WEBHOOK_EVENTS.filter((wire) => wires.includes(wire)),
  ];
}

/** Blocks a summary report can be built from. */
export const REPORT_SECTIONS = ["backups", "readiness", "failures", "storage", "restores"] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

export function isReportSection(value: string): value is ReportSection {
  return (REPORT_SECTIONS as readonly string[]).includes(value);
}

/** Periods a summary report can cover, in days. */
export const REPORT_PERIOD_DAYS = [1, 7, 30, 90] as const;

/** Upper bounds that keep a rule readable and a delivery run small. */
export const MAX_REPORT_RECIPIENTS = 20;
export const MAX_REPORT_THROTTLE_MINUTES = 7 * 24 * 60;

/**
 * The deadline an event rule may set for `backup.overdue` ("no successful backup for X
 * hours"), from a day to 30 days. It replaces the bound the jobs' schedules give, for that
 * rule's alerts only (the database checks the same range, report_rules_overdue_after_ck).
 */
export const MIN_OVERDUE_DEADLINE_HOURS = 24;
export const MAX_OVERDUE_DEADLINE_HOURS = 30 * 24;

/** Job queues whose failure raises an event, and the event it raises. */
export const FAILED_JOB_EVENTS: Readonly<Record<string, ReportEvent>> = {
  backup: "backup.failed",
  restore: "restore.failed",
  archive: "archive.failed",
  directory: "directory.failed",
};
