import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ReportCadence } from "@/features/reports/api";

import {
  fetchProviderRecipients,
  fetchSummaryReports,
  type ProviderRecipientInput,
  putProviderRecipients,
  putSummaryReport,
  type SummaryReport,
  testProviderRecipient,
  testSummaryReport,
} from "./api";

/** TanStack Query wiring of Installation › Notifications (0.5.0). */
export const providerNotificationKeys = {
  all: ["provider-notifications"] as const,
  recipients: ["provider-notifications", "recipients"] as const,
  summaries: ["provider-notifications", "summaries"] as const,
};

export function useProviderRecipients() {
  return useQuery({
    queryKey: providerNotificationKeys.recipients,
    queryFn: fetchProviderRecipients,
  });
}

export function useSaveProviderRecipients() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (recipients: ProviderRecipientInput[]) => putProviderRecipients(recipients),
    onSuccess: (view) => {
      queryClient.setQueryData(providerNotificationKeys.recipients, view);
      // Who gets a summary report follows the recipients' columns.
      void queryClient.invalidateQueries({ queryKey: providerNotificationKeys.summaries });
    },
  });
}

export function useTestProviderRecipient() {
  return useMutation({ mutationFn: (id: string) => testProviderRecipient(id) });
}

export function useSummaryReports() {
  return useQuery({ queryKey: providerNotificationKeys.summaries, queryFn: fetchSummaryReports });
}

export function useUpdateSummaryReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      cadence,
      patch,
    }: {
      cadence: ReportCadence;
      patch: Partial<Pick<SummaryReport, "enabled" | "attachPdf" | "sendHour">>;
    }) => putSummaryReport(cadence, patch),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: providerNotificationKeys.summaries }),
  });
}

export function useTestSummaryReport() {
  return useMutation({ mutationFn: (cadence: ReportCadence) => testSummaryReport(cadence) });
}
