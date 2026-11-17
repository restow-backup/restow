import { apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/billing (ee/api/src/billing-close/routes.ts): the closed months of the
 * monthly billing close (0.6.0, Service Provider). The routes answer 404 without the
 * `provider.crossTenantApi` capability, so the section only calls them on that edition.
 */

export type BillingLineType =
  | "mailboxes"
  | "storage"
  | "servers"
  | "clients"
  | "vms"
  | "containers"
  | "fileShares";

export interface BillingPeriodSummary {
  period: string;
  status: "closed";
  timeZone: string;
  startsAt: string;
  endsAt: string;
  closedAt: string;
  currency: string;
  tenants: number;
  total: number | null;
  correctedTotal: number | null;
  corrections: number;
}

export interface BillingPeriodList {
  items: BillingPeriodSummary[];
  open: { period: string; startsAt: string; closesAt: string };
}

export interface BillingPeriodLine {
  type: BillingLineType;
  quantity: number;
  unit: "mailbox" | "unit" | "GB" | "TB";
  unitPrice: number;
  priceSource: "installation" | "tenant";
  amount: number;
  peakDate: string;
}

export interface BillingCorrection {
  id: string;
  tenantId: string;
  type: BillingLineType | null;
  amount: number;
  reason: string;
  createdAt: string;
  createdBy: string;
}

export interface BillingPeriodTenant {
  tenantId: string;
  name: string;
  customerNumber: string | null;
  kind: "customer" | "internal";
  status: "active" | "suspended" | "deleting";
  complete: boolean;
  sampledDays: number;
  lines: BillingPeriodLine[];
  total: number | null;
  corrections: BillingCorrection[];
  correctedTotal: number | null;
}

export interface BillingPeriod {
  period: string;
  status: "closed";
  timeZone: string;
  startsAt: string;
  endsAt: string;
  closedAt: string;
  currency: string;
  storageBilling: "exact" | "block_100gb" | "block_1tb";
  days: number;
  sampledDays: number;
  tenants: BillingPeriodTenant[];
  total: number | null;
  correctedTotal: number | null;
  missing: number;
}

export interface CreateCorrectionInput {
  tenantId: string;
  type?: BillingLineType;
  amount: number;
  reason: string;
}

export const BILLING_PATH = "/billing/periods";

export function fetchBillingPeriods(): Promise<BillingPeriodList> {
  return apiFetch<BillingPeriodList>(BILLING_PATH);
}

export function fetchBillingPeriod(period: string): Promise<BillingPeriod> {
  return apiFetch<BillingPeriod>(`${BILLING_PATH}/${encodeURIComponent(period)}`);
}

export function createBillingCorrection(
  period: string,
  input: CreateCorrectionInput,
): Promise<BillingCorrection> {
  return apiFetch<BillingCorrection>(`${BILLING_PATH}/${encodeURIComponent(period)}/corrections`, {
    method: "POST",
    body: input,
  });
}

/** The path of a month's CSV, for downloadFile. */
export function billingCsvPath(period: string): string {
  return `${BILLING_PATH}/${encodeURIComponent(period)}/csv`;
}

export const billingKeys = {
  all: ["installation", "billing"] as const,
  list: () => ["installation", "billing", "periods"] as const,
  period: (period: string) => ["installation", "billing", "periods", period] as const,
};
