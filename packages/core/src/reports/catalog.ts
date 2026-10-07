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
  "restore.failed",
  "restore.completed",
  "archive.failed",
  "directory.failed",
  "verify.red",
  "verify.yellow",
  "verify.recovered",
  "scrub.corrupt",
  "scrub.repaired",
  "endpoint.stale",
  "endpoint.suspicious_snapshot",
  "endpoint.storage_quota",
  "endpoint.repository_locked",
  "update.available",
] as const;

export type ReportEvent = (typeof REPORT_EVENTS)[number];

export type ReportEventLevel = "info" | "warning" | "error";

export interface ReportEventInfo {
  readonly group: "jobs" | "recoverability" | "storage" | "system";
  readonly level: ReportEventLevel;
}

export const REPORT_EVENT_INFO: Readonly<Record<ReportEvent, ReportEventInfo>> = {
  "backup.failed": { group: "jobs", level: "error" },
  // No successful backup of a mailbox, OneDrive, IMAP account, server or client for longer than
  // its jobs' schedules allow (twice the longest planned gap; apps/worker overdue.ts).
  "backup.overdue": { group: "jobs", level: "warning" },
  "restore.failed": { group: "jobs", level: "error" },
  "restore.completed": { group: "jobs", level: "info" },
  "archive.failed": { group: "jobs", level: "error" },
  "directory.failed": { group: "jobs", level: "warning" },
  "verify.red": { group: "recoverability", level: "error" },
  "verify.yellow": { group: "recoverability", level: "warning" },
  "verify.recovered": { group: "recoverability", level: "info" },
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
  "update.available": { group: "system", level: "info" },
};

/**
 * Events about the installation, not about one tenant's data. They are raised
 * once for the whole installation and reach the rules of every tenant that
 * lists them, but only provider administrators may put them into a rule (a
 * tenant's own administrators are not told about the operator's updates).
 */
export const INSTALLATION_REPORT_EVENTS: readonly ReportEvent[] = ["update.available"];

export function isInstallationReportEvent(event: string): boolean {
  return (INSTALLATION_REPORT_EVENTS as readonly string[]).includes(event);
}

export function isReportEvent(value: string): value is ReportEvent {
  return (REPORT_EVENTS as readonly string[]).includes(value);
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

/** Job queues whose failure raises an event, and the event it raises. */
export const FAILED_JOB_EVENTS: Readonly<Record<string, ReportEvent>> = {
  backup: "backup.failed",
  restore: "restore.failed",
  archive: "archive.failed",
  directory: "directory.failed",
};
