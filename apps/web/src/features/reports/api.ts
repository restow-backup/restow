import { apiFetch } from "@/lib/api";

/**
 * Client of /api/v1/reports and /api/v1/notifications
 * (apps/api/src/features/reports/routes.ts). Every request carries the
 * active tenant (apiFetch).
 */

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

export const REPORT_SECTIONS = ["backups", "readiness", "failures", "storage", "restores"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export type ReportTrigger = "event" | "schedule";
export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";
export type ReportChannel = "email" | "in_app" | "webhook";

export interface ReportRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: ReportTrigger;
  events: ReportEvent[];
  throttleMinutes: number;
  intervalMinutes: number | null;
  cron: string | null;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  periodDays: number;
  sections: ReportSection[];
  emailRecipients: string[];
  /**
   * Set when the rule carries one category of the tenant's notification recipients
   * (`jobFailures`, `readinessRed`, `weeklyReport`): its addresses are the recipients who
   * chose that category and change only there.
   */
  recipientCategory: string | null;
  inApp: boolean;
  webhookId: string | null;
  language: "de" | "en" | null;
  /**
   * The rule's own deadline for `backup.overdue` in hours (24 to 720); null follows the jobs'
   * schedules (absent from an older server).
   */
  overdueAfterHours?: number | null;
  locked: boolean;
  lastDelivery: { at: string; status: DeliveryStatus } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRuleInput {
  trigger: ReportTrigger;
  name: string;
  enabled: boolean;
  events: ReportEvent[];
  throttleMinutes: number;
  intervalMinutes: number | null;
  cron: string | null;
  timezone: string;
  periodDays: number;
  sections: ReportSection[];
  emailRecipients: string[];
  inApp: boolean;
  webhookId: string | null;
  language: "de" | "en" | null;
  /** The rule's own deadline for `backup.overdue` in hours; null follows the schedules. */
  overdueAfterHours?: number | null;
}

export type ReportRulePatch = Partial<Omit<ReportRuleInput, "trigger">>;

export interface ReportDelivery {
  id: string;
  ruleId: string | null;
  ruleName: string;
  kind: "event" | "summary";
  event: ReportEvent | null;
  channel: ReportChannel;
  recipient: string | null;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  target: string | null;
  /** What the alert is about, for links: the protected object, the machine, the run. */
  subject?: {
    objectId: string | null;
    endpointId: string | null;
    /** A VM or container of Proxmox VE (absent from an older server). */
    guestId?: string | null;
    jobId: string | null;
  };
  /** A webhook alert: the webhook and the delivery it was handed to (its outcome is `status`). */
  webhook?: { id: string; deliveryId: string | null } | null;
  /** In the view across tenants: whose alert it is. */
  tenant?: { id: string; name: string };
}

/** Filters of the delivery log (all optional); `before` pages back. */
export interface DeliveryFilters {
  ruleId?: string | null;
  status?: DeliveryStatus | null;
  before?: string | null;
}

export interface ReportCatalog {
  events: { name: ReportEvent; group: "jobs" | "recoverability" | "storage"; level: string }[];
  sections: ReportSection[];
  periods: number[];
  scheduledAvailable: boolean;
}

export interface BellNotification {
  id: string;
  tenantId: string | null;
  /** In the lists across tenants: the tenant's name, for the entry and its link. */
  tenant?: { id: string; name: string };
  level: "info" | "warning" | "error";
  event: string;
  message: string;
  details: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}

export interface BellList {
  items: BellNotification[];
  unread: number;
  /**
   * Of the unread ones, how many are warnings or errors. The bell badge turns
   * red only for these; absent from a server that predates it, where the
   * newest entries stand in.
   */
  unreadAttention?: number;
}

/** A page of the notification history (GET /notifications/history). */
export interface NotificationPage {
  items: BellNotification[];
  /** Pass as `before` for the next older page; null at the end. */
  next: string | null;
}

export interface NotificationFilters {
  level?: "info" | "warning" | "error" | "attention" | null;
  unread?: boolean;
}

export const reportKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "reports"] as const,
  rules: (tenantId: string | null) => ["tenant", tenantId, "reports", "rules"] as const,
  catalog: (tenantId: string | null) => ["tenant", tenantId, "reports", "catalog"] as const,
  deliveries: (tenantId: string | null, filters: DeliveryFilters = {}) =>
    [
      "tenant",
      tenantId,
      "reports",
      "deliveries",
      filters.ruleId ?? null,
      filters.status ?? null,
    ] as const,
  history: (tenantId: string | null, filters: NotificationFilters = {}) =>
    [
      "tenant",
      tenantId,
      "notifications",
      "history",
      filters.level ?? null,
      !!filters.unread,
    ] as const,
  /** Every covered tenant's notifications and deliveries ("All tenants", Service Provider). */
  providerBell: ["provider", "notifications"] as const,
  providerHistory: (filters: NotificationFilters = {}) =>
    ["provider", "notifications", "history", filters.level ?? null, !!filters.unread] as const,
  providerDeliveries: (filters: DeliveryFilters = {}) =>
    ["provider", "deliveries", filters.status ?? null] as const,
  bell: (tenantId: string | null) => ["tenant", tenantId, "notifications"] as const,
  /** The installation-level bell of a provider administrator who has no tenant open. */
  installationBell: ["installation", "notifications"] as const,
};

const base = "/reports";

export const fetchCatalog = () => apiFetch<ReportCatalog>(`${base}/catalog`);
export const fetchRules = () => apiFetch<ReportRule[]>(`${base}/rules`);
export const createRule = (input: ReportRuleInput) =>
  apiFetch<ReportRule>(`${base}/rules`, { method: "POST", body: input });
export const updateRule = (id: string, patch: ReportRulePatch) =>
  apiFetch<ReportRule>(`${base}/rules/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
export const deleteRule = (id: string) =>
  apiFetch<void>(`${base}/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
export const testRule = (id: string) =>
  apiFetch<{ queued: number }>(`${base}/rules/${encodeURIComponent(id)}/test`, { method: "POST" });
/** The query string of the delivery filters (empty when there are none). */
export function deliveryQuery(filters: DeliveryFilters, limit?: number): string {
  const params = new URLSearchParams();
  if (filters.ruleId) params.set("ruleId", filters.ruleId);
  if (filters.status) params.set("status", filters.status);
  if (filters.before) params.set("before", filters.before);
  if (limit) params.set("limit", String(limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Rows per page of the delivery log. */
export const DELIVERY_PAGE = 50;

export const fetchDeliveries = (filters: DeliveryFilters = {}) =>
  apiFetch<ReportDelivery[]>(`${base}/deliveries${deliveryQuery(filters, DELIVERY_PAGE)}`);

/** The delivery log as CSV (through apiFetch, so the active tenant goes along). */
export const DELIVERIES_EXPORT_PATH = `${base}/deliveries/export`;
export const PROVIDER_DELIVERIES_EXPORT_PATH = "/notifications/provider/deliveries/export";

export const fetchProviderDeliveries = (filters: DeliveryFilters = {}) =>
  apiFetch<ReportDelivery[]>(
    `/notifications/provider/deliveries${deliveryQuery(filters, DELIVERY_PAGE)}`,
  );

function historyQuery(filters: NotificationFilters, before: string | null): string {
  const params = new URLSearchParams();
  if (filters.level) params.set("level", filters.level);
  if (filters.unread) params.set("unread", "true");
  if (before) params.set("before", before);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const fetchHistory = (filters: NotificationFilters, before: string | null) =>
  apiFetch<NotificationPage>(`/notifications/history${historyQuery(filters, before)}`);

/** Every covered tenant's notifications with their tenant ("All tenants", Service Provider). */
export const fetchProviderHistory = (filters: NotificationFilters, before: string | null) =>
  apiFetch<NotificationPage & { unread: number; unreadAttention: number }>(
    `/notifications/provider${historyQuery(filters, before)}`,
  );
export const markProviderBellRead = (body: { ids?: string[]; all?: true }) =>
  apiFetch<{ updated: number }>("/notifications/provider/read", { method: "POST", body });

export const fetchBell = () => apiFetch<BellList>("/notifications");
export const markBellRead = (body: { ids?: string[]; all?: true }) =>
  apiFetch<{ updated: number }>("/notifications/read", { method: "POST", body });

/** Installation-level notifications only: needs no tenant, provider administrators only. */
export const fetchInstallationBell = () => apiFetch<BellList>("/notifications/installation");
export const markInstallationBellRead = (body: { ids?: string[]; all?: true }) =>
  apiFetch<{ updated: number }>("/notifications/installation/read", { method: "POST", body });
