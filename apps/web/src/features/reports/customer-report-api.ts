import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";

/**
 * Client of a tenant's customer monthly report (0.5.0, Service Provider, gate
 * `reports.customer`; apps/api features/reports/customer-report.ts): the report the provider
 * sends to the tenant's contacts once a month, with the provider's (or the tenant's) branding,
 * as HTML mail and PDF. Provider administrators only.
 */

export interface CustomerReportSettings {
  available: boolean;
  enabled: boolean;
  /** Day of the month, 1 to 28. */
  sendDay: number;
  sendHour: number;
  timezone: string;
  language: "de" | "en" | null;
  /** The contacts who receive it (Master data). */
  recipients: { contactId: string; name: string; email: string }[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastDelivery: { at: string; status: string } | null;
}

export type CustomerReportPatch = Partial<
  Pick<CustomerReportSettings, "enabled" | "sendDay" | "sendHour" | "language">
>;

const base = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}/customer-report`;

/** The path of the PDF preview of the last month (below `/api/v1`). */
export function customerReportPdfPath(tenantId: string, lang: string): string {
  const params = new URLSearchParams();
  if (lang === "de" || lang === "en") params.set("lang", lang);
  const query = params.toString();
  return `${base(tenantId)}/preview.pdf${query ? `?${query}` : ""}`;
}

export const fetchCustomerReport = (tenantId: string) =>
  apiFetch<CustomerReportSettings>(base(tenantId));
export const putCustomerReport = (tenantId: string, patch: CustomerReportPatch) =>
  apiFetch<CustomerReportSettings>(base(tenantId), { method: "PUT", body: patch });
export const testCustomerReport = (tenantId: string) =>
  apiFetch<{ to: string }>(`${base(tenantId)}/test`, { method: "POST" });

export const customerReportKeys = {
  settings: (tenantId: string) => ["tenant", tenantId, "customer-report"] as const,
};

export function useCustomerReport(tenantId: string) {
  return useQuery({
    queryKey: customerReportKeys.settings(tenantId),
    queryFn: () => fetchCustomerReport(tenantId),
  });
}

export function useUpdateCustomerReport(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: CustomerReportPatch) => putCustomerReport(tenantId, patch),
    onSuccess: (settings) =>
      queryClient.setQueryData(customerReportKeys.settings(tenantId), settings),
  });
}

export function useTestCustomerReport(tenantId: string) {
  return useMutation({ mutationFn: () => testCustomerReport(tenantId) });
}
