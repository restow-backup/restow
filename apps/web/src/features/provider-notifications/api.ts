import type {
  DeliveryModes,
  EventGroup,
  EventLevel,
  RecipientFailure,
  ReportCadence,
  ReportEvent,
} from "@/features/reports/api";
import { apiFetch } from "@/lib/api";

/**
 * Client of the provider's notification recipients and summary reports (0.5.0,
 * apps/api features/provider-notifications), under `/settings`: installation wide, no tenant
 * header. The recipients get alerts about every tenant and the installation itself; the owners
 * of the provider team and the recipients an owner marks mandatory are the floor, who always get
 * the critical events and failed deliveries.
 */

/** A summary report a recipient can tick (its column holds the entry). */
export const SUMMARY_ENTRIES = ["report.daily", "report.weekly", "report.monthly"] as const;
export type SummaryEntry = (typeof SUMMARY_ENTRIES)[number];

export interface ProviderRecipient {
  id: string;
  email: string;
  name: string | null;
  kind: "owner" | "member";
  mandatory: boolean;
  userId: string | null;
  /** Catalog events and summary entries. */
  events: string[];
  delivery: DeliveryModes;
  language: "de" | "en" | null;
  /** Events this recipient gets whatever its column says (the floor's). */
  lockedEvents: ReportEvent[];
  failure: RecipientFailure | null;
}

export interface ProviderRecipientsView {
  events: {
    name: ReportEvent;
    group: EventGroup;
    level: EventLevel;
    critical: boolean;
    installation: boolean;
  }[];
  summaryAvailable: boolean;
  /** The events the floor always gets: the critical ones and failed deliveries. */
  floorEvents: ReportEvent[];
  /** The viewer is an owner of the provider team: may mark recipients mandatory. */
  canEditMandatory: boolean;
  recipients: ProviderRecipient[];
}

export interface ProviderRecipientInput {
  id?: string;
  email: string;
  name?: string | null;
  mandatory?: boolean;
  events: string[];
  delivery?: Partial<DeliveryModes>;
  language?: "de" | "en" | null;
}

export interface SummaryReport {
  cadence: ReportCadence;
  enabled: boolean;
  attachPdf: boolean;
  sendHour: number;
  /** The recipients who ticked it. */
  recipients: string[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastDelivery: { at: string; status: string } | null;
}

export interface SummaryReportsView {
  available: boolean;
  reports: SummaryReport[];
}

export const fetchProviderRecipients = () =>
  apiFetch<ProviderRecipientsView>("/settings/notification-recipients", { tenantId: null });
export const putProviderRecipients = (recipients: ProviderRecipientInput[]) =>
  apiFetch<ProviderRecipientsView>("/settings/notification-recipients", {
    method: "PUT",
    body: { recipients },
    tenantId: null,
  });
export const testProviderRecipient = (id: string) =>
  apiFetch<{ to: string }>(`/settings/notification-recipients/${encodeURIComponent(id)}/test`, {
    method: "POST",
    tenantId: null,
  });

export const fetchSummaryReports = () =>
  apiFetch<SummaryReportsView>("/settings/summary-reports", { tenantId: null });
export const putSummaryReport = (
  cadence: ReportCadence,
  patch: Partial<Pick<SummaryReport, "enabled" | "attachPdf" | "sendHour">>,
) =>
  apiFetch<SummaryReport>(`/settings/summary-reports/${cadence}`, {
    method: "PUT",
    body: patch,
    tenantId: null,
  });
export const testSummaryReport = (cadence: ReportCadence) =>
  apiFetch<{ to: string }>(`/settings/summary-reports/${cadence}/test`, {
    method: "POST",
    tenantId: null,
  });
