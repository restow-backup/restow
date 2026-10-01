import { apiFetch } from "@/lib/api";

/**
 * Client of /api/v1/reports and /api/v1/notifications
 * (apps/api/src/features/reports/routes.ts). Every request carries the
 * active tenant (apiFetch).
 */

export const REPORT_EVENTS = [
  "backup.failed",
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
  inApp: boolean;
  webhookId: string | null;
  language: "de" | "en" | null;
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

export const reportKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "reports"] as const,
  rules: (tenantId: string | null) => ["tenant", tenantId, "reports", "rules"] as const,
  catalog: (tenantId: string | null) => ["tenant", tenantId, "reports", "catalog"] as const,
  deliveries: (tenantId: string | null, ruleId: string | null) =>
    ["tenant", tenantId, "reports", "deliveries", ruleId] as const,
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
export const fetchDeliveries = (ruleId: string | null) =>
  apiFetch<ReportDelivery[]>(
    `${base}/deliveries${ruleId ? `?ruleId=${encodeURIComponent(ruleId)}` : ""}`,
  );

export const fetchBell = () => apiFetch<BellList>("/notifications");
export const markBellRead = (body: { ids?: string[]; all?: true }) =>
  apiFetch<{ updated: number }>("/notifications/read", { method: "POST", body });

/** Installation-level notifications only: needs no tenant, provider administrators only. */
export const fetchInstallationBell = () => apiFetch<BellList>("/notifications/installation");
export const markInstallationBellRead = (body: { ids?: string[]; all?: true }) =>
  apiFetch<{ updated: number }>("/notifications/installation/read", { method: "POST", body });
